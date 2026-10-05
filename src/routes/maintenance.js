'use strict';

/*
 * 维护接口（仅保管员）：
 *   POST /api/maintenance/rebuild-usage  全量重建年度占用派生表 annual_usage。
 * 一次调用按全部选中展品原子生效：所有选中展品在同一事务内（按展品 id 升序加
 * 应用层键锁 + 展品行锁，与同展品日常占用变更互斥串行）逐个「先删旧派生行 →
 * 按线上同一统一剂量口径逐年写回 → 同步预警阈值最近占用/级别（不补发事件）」；
 * 任一展品任一年份失败，整个事务回滚并返回明确错误——所有选中展品的派生占用与
 * 预警最近状态均保持操作前的值，绝不留下新旧占用混杂的结果。修复原因后可原样重试（幂等）。
 * body 可选 { exhibitIds: [..] } 只重建指定展品；不传则重建全部展品。
 */

const express = require('express');
const { query } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { rebuildExhibitsUsageAtomic } = require('../usage');

const router = express.Router();

router.use(requireAuth);

router.post('/rebuild-usage', requireRole('conservator'), async (req, res, next) => {
  try {
    let exhibitIds = null;
    if (req.body && Array.isArray(req.body.exhibitIds)) {
      exhibitIds = req.body.exhibitIds.map(Number);
      if (exhibitIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: 'exhibitIds 必须为正整数数组' });
      }
    }

    let ids;
    if (exhibitIds) {
      ids = [...new Set(exhibitIds)].sort((a, b) => a - b);
      if (ids.length > 0) {
        const ph = ids.map((_, i) => `$${i + 1}`).join(',');
        const { rows } = await query(
          `SELECT id FROM exhibits WHERE id IN (${ph}) ORDER BY id`, ids);
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((r) => Number(r.id)));
          const missing = ids.filter((id) => !found.has(id));
          return res.status(400).json({ error: `展品不存在：${missing.join('、')}` });
        }
      }
    } else {
      ids = (await query('SELECT id FROM exhibits ORDER BY id')).rows.map((r) => Number(r.id));
    }

    // 单次事务原子重建全部选中展品：任一失败整体回滚，
    // 所有选中展品的派生占用与预警最近状态均保持操作前的值。
    const rebuilt = await rebuildExhibitsUsageAtomic(ids);

    res.json({
      ok: true,
      exhibitCount: rebuilt.length,
      yearCount: rebuilt.reduce((s, r) => s + r.years.length, 0),
      exhibits: rebuilt.map((r) => ({ exhibitId: r.exhibitId, yearCount: r.years.length, years: r.years })),
    });
  } catch (err) {
    next(err);
  }
});

// 未知维护路径 404（而非落到静态页）。
router.use((req, res) => {
  res.status(404).json({ error: `未知维护接口：${req.method} ${req.path}` });
});

module.exports = router;
