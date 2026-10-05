'use strict';

const { Pool } = require('pg');
const pgTypes = require('pg').types;
const config = require('./config');

// DATE 列以 'YYYY-MM-DD' 字符串返回，避免被驱动按 UTC 转成 Date 后日期漂移。
pgTypes.setTypeParser(1082, (v) => v);
// NUMERIC 直接转为 JS number；本系统数值范围小，精度足够。
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  database: config.pg.database,
  user: config.pg.user,
  password: config.pg.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // 空闲连接出错，仅记录，避免进程崩溃。
  console.error('[pg] 空闲连接错误:', err.message);
});

/**
 * 进程内键级互斥队列：同一 key 的临界区严格串行。
 * 用途：与 PostgreSQL 的 SELECT ... FOR UPDATE 行锁互为双保险，
 * 保证单实例内对同一展品的并发批准/确认不会超配（无论底层驱动是否支持阻塞行锁）。
 * 实现：每个 key 维护一个 Promise 链尾，后来者先排队等待，结束后摘下自己。
 */
const lockTails = new Map();
async function withKeyLock(key, work) {
  const prev = lockTails.get(key);
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  // 新链尾：前序结束（无论成败）后再等 mine 释放
  const queued = (prev || Promise.resolve()).then(
    () => mine,
    () => mine
  );
  lockTails.set(key, queued);
  if (prev) {
    try {
      await prev;
    } catch (_) {
      /* 前序失败不阻塞队列 */
    }
  }
  try {
    return await work();
  } finally {
    release();
    // 微任务后若链尾没有变化（没有后来者替换它），回收该 key
    const current = queued;
    queueMicrotask(() => {
      if (lockTails.get(key) === current) lockTails.delete(key);
    });
  }
}

/**
 * 在事务中执行 work(client)；work 抛错则回滚，否则提交。
 * 行级锁（SELECT ... FOR UPDATE）必须在此处获取。
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[pg] 回滚失败:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 以“展品行”为粒度的串行化事务：应用层互斥 + DB 行锁双保险。 */
async function withExhibitTransaction(exhibitId, work) {
  return withKeyLock(`exhibit:${exhibitId}`, () => withTransaction(work));
}

/**
 * 跨多展品的串行化事务（联合核准等一次涉及多件展品的操作）：
 *  - 应用层按展品 id 升序逐个取得键锁，避免多展品事务间循环等待；
 *  - 事务内同样按升序 SELECT ... FOR UPDATE 锁展品行。
 * 同一展品的联合核准与既有单展品事务经同一键锁互斥，不会超配。
 */
async function withExhibitsTransaction(exhibitIds, work) {
  const ids = [...new Set(exhibitIds.map(Number))].sort((a, b) => a - b);
  const keys = ids.map((id) => `exhibit:${id}`);
  return withOrderedKeyTransaction(keys, async (client) => {
    for (const exId of ids) {
      await client.query('SELECT id FROM exhibits WHERE id = $1 FOR UPDATE', [exId]);
    }
    return work(client);
  });
}

/**
 * 按给定顺序逐个取得应用层键锁（键序由调用方保证全局一致），全部取得后执行 work。
 * 与 withKeyLock 不同，这里不去重/不排序——调用方负责给出无环的加锁顺序。
 */
async function withKeyLocksOrdered(orderedKeys, work) {
  const keys = [...new Set(orderedKeys)];
  const runLocked = (idx) => {
    if (idx >= keys.length) return work();
    return withKeyLock(keys[idx], () => runLocked(idx + 1));
  };
  return runLocked(0);
}

/**
 * 按全局键序逐个取得应用层键锁后开事务（用于一次同时涉及展厅与多件展品的操作，
 * 如共享照明登记、跨展厅驻留修改）。键名统一按字典序加锁，避免跨键事务循环等待；
 * 调用方应在 work 内按同一顺序对相应行 SELECT ... FOR UPDATE。
 */
async function withOrderedKeyTransaction(lockKeys, work) {
  const keys = [...new Set(lockKeys)].sort();
  return withKeyLocksOrdered(keys, () => withTransaction(work));
}

/**
 * 展厅 + 展品混合加锁的统一全局键序：**先全部展厅键（按 hallId 升序），
 * 再全部展品键（按 exhibitId 升序）**。
 * 共享照明登记只能在进入事务、持有展厅锁之后才能读准“最终归属展品集合”，
 * 因此展品键必须晚于展厅键获取；驻留的登记/改删与共享照明登记共用此顺序，
 * 保证两类事务之间不会形成加锁环（死锁）。调用方须在 work 内按同一顺序
 * 先对展厅行、再对展品行 SELECT ... FOR UPDATE。
 */
function hallExhibitLockKeys(hallIds, exhibitIds) {
  const halls = [...new Set((hallIds || []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .map((id) => `hall:${id}`);
  const exhibits = [...new Set((exhibitIds || []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .map((id) => `exhibit:${id}`);
  return [...halls, ...exhibits];
}

/**
 * 按给定顺序逐个取得应用层键锁后开事务（键序由调用方负责，必须使用全局一致的
 * 加锁顺序以避免循环等待）。用于“展厅 + 展品”这类需要固定分组顺序的事务。
 */
async function withKeyOrderedTransaction(orderedKeys, work) {
  const keys = [...new Set(orderedKeys)];
  return withKeyLocksOrdered(keys, () => withTransaction(work));
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
  withTransaction,
  withKeyLock,
  withKeyLocksOrdered,
  withExhibitTransaction,
  withExhibitsTransaction,
  withOrderedKeyTransaction,
  withKeyOrderedTransaction,
  hallExhibitLockKeys,
};
