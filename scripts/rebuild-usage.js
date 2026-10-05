'use strict';

/*
 * 派生占用表 annual_usage 的全量重建脚本（既有数据可重建派生结果）。
 *
 *   node scripts/rebuild-usage.js [展品id…]
 *
 * - 一次运行按全部选定展品原子生效：所有选定展品在同一事务内（按展品 id 升序加
 *   应用层键锁 + 展品行锁，与线上日常占用变更互斥串行）逐展品重建全部相关自然年的
 *   annual_usage：先删除旧派生行，再用与线上完全相同的统一剂量口径（computeOccupancy
 *   按年计算）逐行写回；同时把分级预警阈值行的 last_used_lxh / last_level 同步为
 *   最新值（仅同步边沿判定基线，不补发任何历史事件）。
 * - 任一展品任一年份失败：整个事务回滚，本次选定的全部展品的派生占用与预警最近
 *   状态均保持运行前的值，脚本以非零码退出并打印明确错误；修复原因后可原样重试（幂等）。
 * - 默认重建全部展品，可传展品 id 作为参数只重建指定展品：
 *     node scripts/rebuild-usage.js 3 5
 */

const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/init');
const { rebuildExhibitsUsageAtomic } = require('../src/usage');

async function main() {
  const rawArgs = process.argv.slice(2);
  const argIds = rawArgs.map(Number);
  if (argIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`展品 id 参数必须为正整数：${rawArgs.join(' ')}`);
  }
  await initializeDatabase();

  let exhibitIds;
  if (argIds.length > 0) {
    exhibitIds = [...new Set(argIds)].sort((a, b) => a - b);
    const ph = exhibitIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `SELECT id FROM exhibits WHERE id IN (${ph}) ORDER BY id`, exhibitIds);
    if (rows.length !== exhibitIds.length) {
      const found = new Set(rows.map((r) => Number(r.id)));
      const missing = exhibitIds.filter((id) => !found.has(id));
      throw new Error(`展品不存在：${missing.join('、')}`);
    }
  } else {
    const { rows } = await pool.query('SELECT id FROM exhibits ORDER BY id');
    exhibitIds = rows.map((r) => Number(r.id));
  }

  // 单次事务原子重建全部选定展品：任一失败整体回滚，不留下新旧占用混杂的结果。
  const rebuilt = await rebuildExhibitsUsageAtomic(exhibitIds);

  let totalYears = 0;
  for (const { exhibitId, years } of rebuilt) {
    totalYears += years.length;
    console.log(`[rebuild-usage] 展品 #${exhibitId}：重建 ${years.length} 个自然年（${years.join(', ') || '无'}）`);
  }
  console.log(`[rebuild-usage] 完成：${rebuilt.length} 件展品，${totalYears} 个年度占用行（单次事务原子提交）`);
  await pool.end();
}

main().catch((err) => {
  console.error(
    '[rebuild-usage] 重建失败：事务已整体回滚，本次选定的全部展品的派生占用与预警最近状态' +
    '均保持运行前的值（未改动既有源数据）。修复原因后可原样重试：',
    err
  );
  process.exit(1);
});
