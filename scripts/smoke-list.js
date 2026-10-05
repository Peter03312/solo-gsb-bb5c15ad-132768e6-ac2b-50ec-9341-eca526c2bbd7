'use strict';

/*
 * 本轮列表修复的可调用 HTTP 冒烟脚本（不依赖真实 PostgreSQL，用 pg-mem 起内存库）：
 *   node scripts/smoke-list.js
 * 关键点：把列表查询涉及的 BIGINT 列强制以**字符串**返回，复刻真实 pg 驱动行为，
 * 验证 GET /api/exhibits 的年度概况与低/高档计数，且多展品/跨年不串号。
 * 真实部署中同样的调用即：
 *   curl -c c.txt -X POST http://localhost:3000/api/auth/login \
 *     -H 'Content-Type: application/json' -d '{"username":"custodian","password":"guard123"}'
 *   curl -b c.txt http://localhost:3000/api/exhibits
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const fakePool = new (mem.adapters.createPg().Pool)();
dbModule.pool.connect = (...a) => fakePool.connect(...a);
dbModule.pool.query = (...a) => fakePool.query(...a);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');

const cookieStore = new Map();
function call(method, path, body, role) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(role && cookieStore.has(role) ? { Cookie: `lqsession=${cookieStore.get(role)}` } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        if (role && res.headers['set-cookie']) {
          const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
          if (m) cookieStore.set(role, m[1]);
        }
        resolve({ status: res.statusCode, body: JSON.parse(chunks || 'null') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let base;

async function main() {
  await initializeDatabase();
  const app = createApp();
  await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login = await call('POST', '/api/auth/login',
    { username: process.env.SEED_CONSERVATOR_USERNAME || 'custodian',
      password: process.env.SEED_CONSERVATOR_PASSWORD || 'guard123' }, 'c');
  if (login.status !== 200) {
    throw new Error(`保管员登录失败：${login.status} ${JSON.stringify(login.body)}`);
  }
  const loginI = await call('POST', '/api/auth/login',
    { username: process.env.SEED_INSTALLER_USERNAME || 'installer',
      password: process.env.SEED_INSTALLER_PASSWORD || 'setup123' }, 'i');
  if (loginI.status !== 200) {
    throw new Error(`布展员登录失败：${loginI.status} ${JSON.stringify(loginI.body)}`);
  }

  // 展品甲：2040 上限 1000 + 阈值 50/80，批准计划占 800（高档），再下调上限到 500（超额）
  let r = await call('POST', '/api/exhibits', { name: '宋拓兰亭序' }, 'c');
  if (r.status !== 201) throw new Error(`登记展品失败：${r.status} ${JSON.stringify(r.body)}`);
  const a = r.body.exhibit.id;
  await call('POST', `/api/exhibits/${a}/limits`, { year: 2040, limitLxh: 1000 }, 'c');
  await call('POST', `/api/exhibits/${a}/quota-thresholds`,
    { year: 2040, lowPct: 50, highPct: 80 }, 'c');
  r = await call('POST', '/api/plans', {
    exhibitId: a, title: '2040 春展', startDate: '2040-03-01', endDate: '2040-03-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  await call('POST', `/api/plans/${r.body.plan.id}/approve`, {}, 'c');
  await call('POST', `/api/exhibits/${a}/limits`, { year: 2040, limitLxh: 500 }, 'c');
  // 有占用、无上限年份（计划外事故，无需上限即可入账）
  await call('POST', '/api/incidents', {
    exhibitId: a, startDate: '2020-06-01', startTime: '09:00',
    endDate: '2020-06-01', endTime: '15:00', actualLux: 100, reason: '无上限年份事故',
  }, 'c');
  // 仅配置阈值、无占用无上限的年份
  await call('POST', `/api/exhibits/${a}/quota-thresholds`,
    { year: 2041, lowPct: 50, highPct: 80 }, 'c');

  // 展品乙：2040 上限 5000、占 3000（低档），另设 2042 空上限
  r = await call('POST', '/api/exhibits', { name: '明笺纸册' }, 'c');
  const b = r.body.exhibit.id;
  await call('POST', `/api/exhibits/${b}/limits`, { year: 2040, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${b}/limits`, { year: 2042, limitLxh: 7000 }, 'c');
  await call('POST', `/api/exhibits/${b}/quota-thresholds`,
    { year: 2040, lowPct: 50, highPct: 80 }, 'c');
  r = await call('POST', '/api/plans', {
    exhibitId: b, title: '2040 夏展', startDate: '2040-07-01', endDate: '2040-07-03',
    periods: ['09:00-17:00'], estimatedLux: 125,
  }, 'i');
  await call('POST', `/api/plans/${r.body.plan.id}/approve`, {}, 'c');

  // —— 复刻真实 pg：列表相关查询的 BIGINT 列以字符串返回 ——
  const orig = dbModule.pool.query;
  dbModule.pool.query = async function (text, params) {
    const out = await orig.call(this, text, params);
    const sql = typeof text === 'string' ? text : text && text.text;
    if (typeof sql === 'string' && /FROM exhibits ORDER BY id/.test(sql) && out.rows) {
      out.rows = out.rows.map((row) => ({ ...row, id: String(row.id) }));
    }
    if (typeof sql === 'string' && /FROM annual_(usage|limits|quota_thresholds)/.test(sql) && out.rows) {
      out.rows = out.rows.map((row) => ({ ...row, exhibit_id: String(row.exhibit_id) }));
    }
    return out;
  };

  const list = await call('GET', '/api/exhibits', null, 'c');
  dbModule.pool.query = orig;

  if (list.status !== 200) throw new Error(`列表非 200：${list.status}`);
  const pick = (id) => list.body.exhibits.find((e) => Number(e.id) === id);
  const ia = pick(a);
  const ib = pick(b);
  console.log('GET /api/exhibits（BIGINT 以字符串返回，等同真实 PostgreSQL）\n');
  console.log(JSON.stringify([
    {
      id: ia.id, name: ia.name,
      years: ia.years,
      quotaAlertsConfigured: ia.quotaAlertsConfigured,
      quotaAlertLow: ia.quotaAlertLow,
      quotaAlertHigh: ia.quotaAlertHigh,
    },
    {
      id: ib.id, name: ib.name,
      years: ib.years,
      quotaAlertsConfigured: ib.quotaAlertsConfigured,
      quotaAlertLow: ib.quotaAlertLow,
      quotaAlertHigh: ib.quotaAlertHigh,
    },
  ], null, 2));

  const check = (cond, msg) => { if (!cond) throw new Error('冒烟断言失败: ' + msg); };
  check(ia.years['2040'].limit === 500 && ia.years['2040'].used === 800
    && ia.years['2040'].remaining === -300 && ia.years['2040'].over === true, '甲 2040 超额');
  check(ia.years['2020'].limit === null && ia.years['2020'].used === 600
    && ia.years['2020'].remaining === null, '甲 2020 无上限+真实占用');
  check(!ia.years['2041'], '甲 2041 仅阈值不进 years');
  check(ia.quotaAlertsConfigured === 2 && ia.quotaAlertHigh === 1 && ia.quotaAlertLow === 0,
    '甲 high=1');
  check(ib.years['2040'].limit === 5000 && ib.years['2040'].used === 3000
    && ib.years['2040'].remaining === 2000 && ib.years['2040'].over === false, '乙 2040');
  check(ib.years['2042'].limit === 7000 && ib.years['2042'].used === 0, '乙 2042 零占用');
  check(!ib.years['2020'] && !ib.years['2041'], '不串号');
  check(ib.quotaAlertsConfigured === 1 && ib.quotaAlertLow === 1 && ib.quotaAlertHigh === 0,
    '乙 low=1');
  console.log('\n冒烟通过：列表上限/已用/剩余/超额与详情同口径，低/高档计数正确，多展品跨年不串号。');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
