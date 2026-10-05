'use strict';

/*
 * 共享照明路由（规则 19）。
 *   GET  /api/shared-lightings        登录：共享照明列表（可按 hallCode / exhibitId 过滤），
 *                                     逐条附按年实际用光、窗内/窗外拆分与各展品归属
 *   POST /api/shared-lightings        保管员：登记一次展厅共享照明
 *     （展厅标识 + 已发生照明起止 + 正数实际照度 + 非空原因）
 * 照明按与驻留区间的交集归属各展品并跨自然年拆分；与任一归属展品的未作废实测、停灯或已有
 * 照明事故相交则整次登记拒绝（409，按展品分组列出全部冲突，不保存）；无展品驻留交集拒绝。
 * 多展品计量及超限引发的待复核变更在同一事务原子生效；超限仍入账，返回各展品超额年份。
 * 共享照明记录永久保留：PUT/DELETE/:id 一律 400。
 */

const express = require('express');
const { query, withTransaction, withKeyLock } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  ConflictError,
  assertDate,
  positiveNumber,
  nonEmptyString,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  getHallByCode,
  getHallById,
  getResidencesIntersecting,
  registerSharedLighting,
  loadSharedLightingView,
  getOccupyingPlans,
  plansToFlag,
} = require('../service');
const { wallToTs, tsToWallString, doseByYear, yearMapToObject } = require('../dosing');

const router = express.Router();

/**
 * 内部并发测试挂点（仅供集成测试复现“预读驻留后、正式归属前有驻留迁入/迁出”，
 * 生产不设置即为空操作；勿在业务代码中依赖）。
 * @type {{ beforeHallLock: ((ctx: {hallId:number, input:object}) => Promise|void)|null }}
 */
const concurrencyHooks = { beforeHallLock: null };

router.use(requireAuth);

/** loadSharedLightingView 条目对外字段（驼峰）。 */
function serializeSharedLighting(x) {
  return {
    id: x.id,
    hallId: x.hallId,
    hallCode: x.hallCode,
    exhibitId: x.exhibitId,
    start: x.start,
    end: x.end,
    actualLux: x.actualLux,
    reason: x.reason,
    createdBy: x.createdBy,
    creatorName: x.creatorName || null,
    createdAt: x.createdAt,
    yearly: x.yearly || {},
    yearlyInside: x.yearlyInside || {},
    yearlyOutside: x.yearlyOutside || {},
    insidePlanIds: x.insidePlanIds || [],
    allocations: x.allocations || [],
  };
}

/**
 * 共享照明列表（只读，任何登录用户均可查）。
 * 过滤参数（均可空）：hallCode（按展厅）、exhibitId（按归属展品）。
 * 一次共享照明归属多件展品时，按展品各返回一条同 id 记录（各带本展品的按年拆分与归属段）。
 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const hallCode = req.query.hallCode ? String(req.query.hallCode) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }

    let targetExhibitIds;
    if (exhibitId !== null) {
      targetExhibitIds = [exhibitId];
    } else {
      // hallCode 过滤在各展品视图内按 hallCode 完成（归属表不直接含 hall_code）。
      const { rows } = await query('SELECT id FROM exhibits ORDER BY id');
      targetExhibitIds = rows.map((r) => Number(r.id));
    }

    const items = [];
    for (const exId of targetExhibitIds) {
      const view = await loadSharedLightingView({ query }, exId);
      let list = view.items;
      if (hallCode !== null) list = list.filter((x) => x.hallCode === hallCode);
      items.push(...list.map(serializeSharedLighting));
    }
    items.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
    res.json({ sharedLightings: items });
  } catch (err) {
    next(err);
  }
});

/**
 * 解析共享照明请求体：
 * { hallCode, startDate, [startTime], endDate, [endTime], actualLux, reason }。
 */
function parseSharedLightingBody(body) {
  const hallCode = nonEmptyString(body.hallCode, '展厅标识', 64);
  const startDate = assertDate(body.startDate, '照明开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '照明结束日期') : startDate;
  if (endDate < startDate) throw new ValidationError('照明结束日期不能早于开始日期');
  const startMinute = body.startTime === undefined || body.startTime === null || body.startTime === ''
    ? 0 : parseTimeToMinutes(body.startTime);
  const endMinute = body.endTime === undefined || body.endTime === null || body.endTime === ''
    ? 24 * 60 : parseTimeToMinutes(body.endTime); // 24:00 当日整天
  const cfg = require('../config');
  const startMs = wallToTs(startDate, startMinute);
  let endMs;
  if (endMinute >= 24 * 60) {
    const y = Number(endDate.slice(0, 4));
    const m = Number(endDate.slice(5, 7));
    const d = Number(endDate.slice(8, 10));
    endMs = Date.UTC(y, m - 1, d + 1) - cfg.tzOffsetMs;
  } else {
    endMs = wallToTs(endDate, endMinute);
  }
  const actualLux = positiveNumber(body.actualLux, '共享照明实际照度（lx）', { max: 1000000 });
  const reason = nonEmptyString(body.reason, '共享照明原因', 1000);
  if (!(endMs > startMs)) {
    throw new ValidationError('共享照明起点须早于终点');
  }
  if (endMs > Date.now()) {
    throw new ValidationError(
      `共享照明结束时刻（${tsToWallString(endMs)}）晚于当前时间，只能登记已发生的照明`
    );
  }
  return { hallCode, startMs, endMs, actualLux, reason };
}

/**
 * 保管员登记一次展厅共享照明。
 * 流程（修复“预读驻留后、正式归属前又有驻留登记/迁入完成”的并发缺陷）：
 *  0) 事务外只做快速失败预读（展厅存在、与驻留有交集），**不据此决定归属与加锁集合**；
 *  1) 取得展厅应用键锁（驻留的登记/改删同序先取该键），在该键临界区内用连接池普通读
 *     （不开事务、不取行锁）重读与照明时段相交的驻留，确定**最终归属展品集合**
 *     （无交集 → 400）；
 *  2) 保持展厅键，按展品 id 升序逐个取得全部最终归属展品的应用键锁
 *     （全局固定顺序“展厅 → 展品升序”，与驻留写事务一致，不会死锁）；
 *  3) 全部键锁取得后才开事务，按同序锁展厅行与各展品行，并再次权威重读驻留后做
 *     归属切分 + 冲突收集（未作废实测/停灯/事故）；有冲突整次拒绝 409、不留任何部分记录；
 *     若重读归属集合与已锁定集合不一致（多实例下的极端漂移），直接抛错整次回滚；
 *  4) 原子写入共享照明与**全部最终归属展品**的归属段，逐展品在同一事务内重算年度占用、
 *     分级预警并处理超限；无法对最终归属集合一致入账时整体回滚，绝不提交部分结果；
 *  5) 超限仍入账：返回各展品超额年份，并把相关年度仍有估算残余且尚未开始的已批准计划
 *     转待复核（原因注明由共享照明触发）。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const input = parseSharedLightingBody(req.body || {});

    // 预读仅用于快速失败（真正的归属集合以持有展厅锁后的事务内重读为准）。
    const preHall = await getHallByCode({ query }, input.hallCode);
    if (!preHall) throw new ValidationError(`展厅「${input.hallCode}」不存在，请先登记该展厅的展品驻留`);
    const preResidences = await getResidencesIntersecting(
      { query }, preHall.id, input.startMs, input.endMs
    );
    if (preResidences.length === 0) {
      throw new ValidationError(
        `共享照明时段 ${tsToWallString(input.startMs)} ~ ${tsToWallString(input.endMs)} ` +
        '与该展厅任何展品的驻留区间都没有交集，无法归属，已拒绝'
      );
    }

    // 内部并发测试挂点：预读完成、取得展厅锁之前。生产环境为空操作；
    // 集成测试据此把“另一笔驻留登记/迁入”精确插入到“预读之后、正式归属之前”。
    if (concurrencyHooks.beforeHallLock) {
      await concurrencyHooks.beforeHallLock({ hallId: Number(preHall.id), input });
    }

    // 先只取展厅应用键锁：驻留的登记/改删同序先取该键，故在该键临界区内读到的
    // 相交驻留即为“本实例内归属生效时刻”的驻留集合（这里用连接池普通读取，
    // **不开事务、不取展厅行锁**——行锁一律留到取得全部展品键之后的最终事务里按
    // 同一顺序获取，避免“持有展厅行锁等待展品键”与驻留写事务形成加锁环）。
    const out = await withKeyLock(`hall:${preHall.id}`, async () => {
      const finalResidences = await getResidencesIntersecting(
        { query }, preHall.id, input.startMs, input.endMs
      );
      if (finalResidences.length === 0) {
        throw new ValidationError(
          `共享照明时段 ${tsToWallString(input.startMs)} ~ ${tsToWallString(input.endMs)} ` +
          '与该展厅任何展品的驻留区间都没有交集，无法归属，已拒绝'
        );
      }
      // 最终归属集合：只承认照明登记生效时（展厅锁内）与照明时段相交的驻留。
      const exhibitIds = [...new Set(finalResidences.map((r) => Number(r.exhibit_id)))]
        .sort((a, b) => a - b);

      // 再按展品 id 升序逐个取得全部最终归属展品的应用键锁（全局顺序：展厅 → 展品升序，
      // 与驻留写事务一致，不构成加锁环）；全部取得后才开数据库事务，
      // 保证“先全部应用键锁 → 再事务内行锁 → 提交后释放键锁”，不存在锁序倒置。
      const acquireExhibitLocks = async (idx) => {
        if (idx >= exhibitIds.length) {
          return withTransaction((client) =>
            runSharedLightingTxn(client, preHall.id, exhibitIds, input, req)
          );
        }
        const exId = exhibitIds[idx];
        return withKeyLock(`exhibit:${exId}`, () => acquireExhibitLocks(idx + 1));
      };
      return acquireExhibitLocks(0);
    });

    const allOverflows = out.overflowsByExhibit.flatMap((o) =>
      o.overflows.map((x) => ({ exhibitId: o.exhibitId, ...x }))
    );
    const allAlertEvents = out.alertEventsByExhibit.flatMap((a) => a.events);

    if (allOverflows.length > 0) {
      // 共享照明已入账但造成超限：409 报告各展品超额年份与被转待复核的计划（仍已生效）。
      return res.status(409).json({
        message:
          `共享照明 #${out.sessionId} 已登记并按驻留归属计入实际用光，但登记后超限：` +
          out.overflowsByExhibit
            .filter((o) => o.overflows.length > 0)
            .map((o) =>
              `展品 #${o.exhibitId}：` +
              o.overflows.map((x) => `${x.year} 年超出 ${x.excess} lx·h`).join('；'))
            .join('；') +
          (out.flaggedPlansByExhibit.length
            ? `。已将 ${out.flaggedPlansByExhibit.length} 条尚未开始的计划转为待复核`
            : '；相关年度没有尚未开始的已批准计划'),
        sharedLightingId: out.sessionId,
        overflows: allOverflows,
        overflowsByExhibit: out.overflowsByExhibit,
        flaggedPlans: out.flaggedPlansByExhibit,
        sharedLighting: out.sharedLighting,
        exhibitDetails: out.exhibitDetails,
        quotaAlertEvents: allAlertEvents,
      });
    }

    // 成功响应：单展品时与既有 incident 接口同构（展品详情字段位于顶层）；多展品附 details 数组。
    if (out.exhibitIds.length === 1) {
      return res.status(201).json({
        ...out.exhibitDetails[0],
        sharedLighting: out.sharedLighting[0],
        quotaAlertEvents: allAlertEvents,
      });
    }
    res.status(201).json({
      ok: true,
      sharedLightingId: out.sessionId,
      sharedLighting: out.sharedLighting,
      exhibitIds: out.exhibitIds,
      exhibitDetails: out.exhibitDetails,
      quotaAlertEventsByExhibit: out.alertEventsByExhibit,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 在已持有“展厅应用键锁 + 全部最终归属展品应用键锁”后新开的数据库事务内完成：
 * 按同一顺序对展厅行、展品行 SELECT ... FOR UPDATE；写入共享照明及归属段、写审计 →
 * 逐展品按受影响自然年局部重算（实测/停灯/事故冲突由 registerSharedLighting 先整次拦截，
 * 不会部分落库）、超限转待复核、预警边沿判定、刷新展品详情。
 * 任一步骤抛错都由外层事务整体回滚——不留下任何部分记录。
 */
async function runSharedLightingTxn(client, hallId, exhibitIds, input, req) {
  await client.query('SELECT id FROM halls WHERE id = $1 FOR UPDATE', [hallId]);
  const hall = await getHallById(client, hallId);
  if (!hall) throw new ValidationError(`展厅「${input.hallCode}」不存在，请先登记该展厅的展品驻留`);
  for (const exId of exhibitIds) {
    await lockExhibit(client, exId);
  }

  const { session, allocations } = await registerSharedLighting(
    client,
    { hallId, startMs: input.startMs, endMs: input.endMs,
      actualLux: input.actualLux, reason: input.reason },
    req.sessionUser
  );
  const sessionId = Number(session.id);

  // 一致性校验：事务内权威重读（已按“展厅行 → 各展品行”加锁）得到的归属集合，
  // 必须与取得全部展品键时确定的最终归属集合完全一致。单实例下驻留写事务与本流程
  // 串行于同一展厅键，集合不可能漂移；多实例下若恰有并发迁入/迁出（行锁交错），
  // 无法对原最终归属集合一致入账——整次回滚并以 409 拒绝（调用方原样重发即可）。
  const allocatedExhibitIds = [...new Set(allocations.map((a) => a.exhibitId))].sort((a, b) => a - b);
  if (allocatedExhibitIds.length !== exhibitIds.length ||
      allocatedExhibitIds.some((id, i) => id !== exhibitIds[i])) {
    throw new ConflictError(
      '共享照明登记期间该展厅驻留发生并发变化（有展品迁入或迁出），' +
      '最终归属集合无法一致确定，整次登记未保存，请重新提交',
      { allocationChangedConcurrent: true }
    );
  }

  // 整次共享照明按年剂量（审计用）
  const sessionYearly = yearMapToObject(
    doseByYear([{ start: input.startMs, end: input.endMs }], input.actualLux)
  );
  await recordAudit(client, req.sessionUser, 'shared_lighting.create',
    'shared_lighting', sessionId, {
      hallId: Number(hall.id),
      hallCode: input.hallCode,
      start: tsToWallString(input.startMs),
      end: tsToWallString(input.endMs),
      actualLux: input.actualLux,
      reason: input.reason,
      sessionYearly,
      exhibitIds,
      allocations: allocations.map((a) => ({
        exhibitId: a.exhibitId, residenceId: a.residenceId,
        start: tsToWallString(a.start), end: tsToWallString(a.end), yearly: a.yearly,
      })),
    });

  // 逐展品局部重算本次归属剂量影响到的年份并收集超额；超限仍入账。
  const { recomputeExhibitUsage, refreshUsageYears } = require('../usage');
  const overflowsByExhibit = [];
  const flaggedPlansByExhibit = [];
  const alertEventsByExhibit = [];
  const exhibitDetails = [];
  for (const exId of exhibitIds) {
    const allocsHere = allocations.filter((a) => a.exhibitId === exId);
    const candidateYears = new Set();
    for (const a of allocsHere) for (const y of Object.keys(a.yearly)) candidateYears.add(Number(y));
    const affectedYears = [...candidateYears];

    // 阶段一：先按新入账的归属重算派生占用（同事务、仅限受影响年份，不写预警事件）。
    let occupancy = await refreshUsageYears(client, exId, affectedYears);

    const overflows = [];
    const overflowYears = [];
    for (const year of candidateYears) {
      const info = occupancy.years[String(year)];
      if (!info || info.limit === null) continue;
      if (info.over) {
        overflowYears.push(Number(year));
        overflows.push({
          year: Number(year),
          limit: info.limit,
          projected: info.used,
          excess: Math.round((info.used - info.limit) * 1000) / 1000,
        });
      }
    }
    overflowsByExhibit.push({ exhibitId: exId, overflows });

    if (overflowYears.length > 0) {
      const activePlans = await getOccupyingPlans(client, exId);
      const targets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
      for (const { plan: fp, firstStart } of targets) {
        const reason =
          `共享照明 #${sessionId}（展厅「${input.hallCode}」，${tsToWallString(input.startMs)} ~ ` +
          `${tsToWallString(input.endMs)}）登记后导致 ${overflowYears.join('、')} 年额度超限，转待复核`;
        await client.query(
          `UPDATE plans
              SET status = 'pending_review', review_reason = $2, updated_at = now()
            WHERE id = $1 AND status = 'approved'`,
          [fp.id, reason]
        );
        await recordAudit(client, req.sessionUser, 'plan.flag_review_shared_lighting',
          'plan', fp.id, { triggerSharedLightingId: sessionId, overflowYears });
        flaggedPlansByExhibit.push({
          exhibitId: exId,
          id: fp.id,
          title: fp.title,
          firstStart: tsToWallString(firstStart),
          overflowYears,
        });
      }
    }

    // 阶段二：待复核转态完成后，以最终占用再局部重算一次派生占用并判定预警边沿
    // （同一多展品事务；整次登记回滚时归属/计划状态/派生占用/预警事件一并回滚）。
    const { occupancy: finalOcc, events } = await recomputeExhibitUsage(
      client, exId, affectedYears, {
        actor: req.sessionUser,
        trigger: {
          type: 'shared_lighting.create',
          detail: { sharedLightingId: sessionId, hallCode: input.hallCode },
        },
      }
    );
    occupancy = finalOcc;
    alertEventsByExhibit.push({ exhibitId: exId, events });
  }

  // 刷新各展品详情（含被转待复核后的状态）
  const { exhibitDetail } = require('./exhibits');
  for (const exId of exhibitIds) {
    exhibitDetails.push(await exhibitDetail(client, exId, { lock: true }));
  }
  const freshByExhibit = new Map();
  for (const exId of exhibitIds) {
    const view = await loadSharedLightingView(client, exId);
    freshByExhibit.set(exId, view.items.find((x) => x.id === sessionId) || null);
  }
  const sharedLighting = exhibitIds.map((exId) => {
    const item = freshByExhibit.get(exId);
    return item ? serializeSharedLighting(item) : {
      id: sessionId, hallId: Number(hall.id), hallCode: input.hallCode,
      exhibitId: exId,
      yearly: yearMapToObject(
        doseByYear(
          allocations.filter((a) => a.exhibitId === exId)
            .map((a) => ({ start: a.start, end: a.end })),
          input.actualLux
        )
      ),
    };
  });

  return {
    sessionId,
    exhibitIds,
    exhibitDetails,
    sharedLighting,
    overflowsByExhibit,
    flaggedPlansByExhibit,
    alertEventsByExhibit,
  };
}

// 共享照明记录永久保留：不提供修改/删除接口，显式拒绝并给出中文原因。
router.all('/:id', (req, _res, next) => {
  next(new ValidationError(`共享照明记录保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = { router, serializeSharedLighting, concurrencyHooks };
