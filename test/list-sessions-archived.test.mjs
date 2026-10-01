import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.mjs';

// 通过 apply() 注册的 HTTP handler 测 list-sessions（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。

/**
 * @param opts.headers    persistence.list 返回的 header
 * @param opts.archivedIds 归档集
 * @param opts.groupedIds  有工作区归属的 id；缺省为「全部」（旧默认口径）
 */
function makeCtx({ headers, archivedIds, groupedIds }) {
  const persistence = {
    list: async () => headers,
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
  };
  const ids = groupedIds ?? headers.map((h) => h.id);
  const registry = {
    list: () => [{ sessionIds: ids }],
    requireState: () => ({ archivedSessionIds: archivedIds }),
  };
  const services = { sessionPersistence: persistence, workspaceRegistry: registry };
  let handler = null;
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; } },
  };
  apply(ctx);
  assert.ok(handler, 'apply 应注册 /session-browser/api handler');
  return handler;
}

async function callListSessions(handler, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    url: '/session-browser/api/list-sessions',
    headers: { host: '127.0.0.1:1' },
    [Symbol.asyncIterator]: async function* () { yield raw; },
  };
  let captured = null;
  const res = {
    writeHead: (status) => { captured = { status }; },
    end: (text) => { captured.body = JSON.parse(text); },
  };
  await handler(req, res);
  return captured;
}

const HEADERS = [
  { id: 's-old', cwd: '/ws/proj', createdAt: 1000, updatedAt: 1000 },
  { id: 's-mid', cwd: '/ws/proj', createdAt: 2000, updatedAt: 2000 },
  { id: 's-new', cwd: '/ws/proj', createdAt: 3000, updatedAt: 3000 },
  { id: 's-sub', cwd: '/ws/proj', createdAt: 4000, updatedAt: 4000, origin: 'subagent' },
];
const ARCHIVED = ['s-mid'];

describe('list-sessions 归档分流', () => {
  it('archived=false 排除 archivedIds，每项带 archived:false', async () => {
    const handler = makeCtx({ headers: HEADERS, archivedIds: ARCHIVED });
    const { status, body } = await callListSessions(handler, { archived: false });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const ids = body.items.map((i) => i.sessionId);
    assert.ok(!ids.includes('s-mid'), '已归档 s-mid 不应出现在未归档列表');
    assert.ok(!ids.includes('s-sub'), 'subagent 会话仍被排除');
    for (const item of body.items) assert.equal(item.archived, false);
  });

  it('缺省 archived 与 false 一致（排除已归档）', async () => {
    const handler = makeCtx({ headers: HEADERS, archivedIds: ARCHIVED });
    const { body } = await callListSessions(handler, {});
    const ids = body.items.map((i) => i.sessionId);
    assert.ok(!ids.includes('s-mid'));
    for (const item of body.items) assert.equal(item.archived, false);
  });

  it('archived=true 只返回与 archivedIds 的交集，每项带 archived:true', async () => {
    const handler = makeCtx({ headers: HEADERS, archivedIds: ARCHIVED });
    const { status, body } = await callListSessions(handler, { archived: true });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.items.map((i) => i.sessionId), ['s-mid']);
    for (const item of body.items) assert.equal(item.archived, true);
  });

  it('输出按 createdAt 倒序（新的在前）', async () => {
    const shuffled = [HEADERS[2], HEADERS[0], HEADERS[1], HEADERS[3]];
    const handler = makeCtx({ headers: shuffled, archivedIds: [] });
    const { body } = await callListSessions(handler, {});
    assert.deepEqual(
      body.items.map((i) => i.sessionId),
      ['s-new', 's-mid', 's-old'],
    );
  });
});

describe('list-sessions 未分组（与 DSH 侧边栏「未分组」同口径）', () => {
  // DSH 的 WorkspaceEntity.get sessionIds() 会过滤掉 cwd 与工作区 path 不一致的
  // 成员（entity.ts:102），因此「未归属工作区的历史会话」不在 allowedIds 里。
  // 旧实现只显示 allowedIds 内的会话 → 这些会话在插件里凭空消失。
  const MIXED = [
    { id: 'g1', cwd: '/ws/proj', createdAt: 1000, updatedAt: 1000 },
    { id: 'g2', cwd: '/ws/proj', createdAt: 2000, updatedAt: 2000 },
    { id: 'u1', cwd: '/other/place', createdAt: 3000, updatedAt: 3000 },
  ];

  it('默认页只显示有工作区归属的会话', async () => {
    const handler = makeCtx({ headers: MIXED, archivedIds: [], groupedIds: ['g1', 'g2'] });
    const { body } = await callListSessions(handler, {});
    assert.deepEqual(body.items.map(i => i.sessionId).sort(), ['g1', 'g2']);
  });

  it('ungrouped=true 只显示无工作区归属的会话（侧边栏「未分组」那一堆）', async () => {
    const handler = makeCtx({ headers: MIXED, archivedIds: [], groupedIds: ['g1', 'g2'] });
    const { body } = await callListSessions(handler, { ungrouped: true });
    assert.deepEqual(body.items.map(i => i.sessionId), ['u1'],
      '未归属的历史会话必须可见，否则用户在插件里找不到它');
  });

  it('两个页面互斥且合起来等于全部会话', async () => {
    const handler = makeCtx({ headers: MIXED, archivedIds: [], groupedIds: ['g1'] });
    const grouped = await callListSessions(handler, {});
    const ungrouped = await callListSessions(handler, { ungrouped: true });
    const all = [...grouped.body.items, ...ungrouped.body.items].map(i => i.sessionId).sort();
    assert.deepEqual(all, ['g1', 'g2', 'u1'], '有归属 + 无归属 = 全部');
  });

  it('ungrouped 同样排除已归档会话', async () => {
    const handler = makeCtx({ headers: MIXED, archivedIds: ['u1'], groupedIds: ['g1', 'g2'] });
    const { body } = await callListSessions(handler, { ungrouped: true });
    assert.deepEqual(body.items.map(i => i.sessionId), [],
      '未分组页不应把已归档会话带出来');
  });

  it('全部会话都无归属时，默认页为空、未分组页为全部', async () => {
    const handler = makeCtx({ headers: MIXED, archivedIds: [], groupedIds: [] });
    const g = await callListSessions(handler, {});
    const u = await callListSessions(handler, { ungrouped: true });
    assert.equal(g.body.items.length, 0);
    assert.equal(u.body.items.length, 3);
  });
});

// 标题提取要为每个会话读事件日志，是切页签的主要耗时来源。
// 这里守护三条性能行为：读次数有上限、并发有上限、相同 (id,updatedAt) 不重复读。
describe('list-sessions 标题提取性能', () => {
  function makeCountingCtx({ headers, events, archivedIds = [] }) {
    const stats = { opens: 0, maxConcurrent: 0, concurrent: 0, readsById: {} };
    const persistence = {
      list: async () => headers,
      open: async (id) => {
        stats.opens += 1;
        stats.concurrent += 1;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
        return {
          read: async (offset) => {
            stats.readsById[id] = (stats.readsById[id] || 0) + 1;
            stats.concurrent -= 1;
            // 每次 read 只给一小片，模拟分块读全量事件
            const all = events[id] || [];
            return { events: all.slice(offset, offset + 1) };
          },
          close: async () => {},
        };
      },
    };
    const allIds = headers.map((h) => h.id);
    const registry = {
      list: () => [{ sessionIds: allIds }],
      requireState: () => ({ archivedSessionIds: archivedIds }),
    };
    const services = { sessionPersistence: persistence, workspaceRegistry: registry };
    let handler = null;
    const ctx = {
      get: (name) => services[name],
      effect: (fn) => { fn(); return () => {}; },
      webServer: { register: (route) => { handler = route.handler; } },
    };
    apply(ctx);
    return { handler, stats };
  }

  const MANY = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`, cwd: '/ws/proj', createdAt: 1000 + i, updatedAt: 1000 + i,
  }));
  // 每个会话 1200 条事件（跨越多个 500 分片），标题在第一条。
  // 旧实现会读完所有分片；新实现读到能定标题即停。
  const EVENTS = Object.fromEntries(MANY.map((h) => [h.id, [
    { type: 'user/message', surfaceOp: 'append', data: { content: `标题 ${h.id}` } },
    ...Array.from({ length: 1199 }, (_, k) => ({
      type: 'assistant/message', surfaceOp: 'append', data: { content: `x${k}` },
    })),
  ]]));

  it('长会话不应读满全量事件（读到能定标题即停）', async () => {
    const { handler, stats } = makeCountingCtx({ headers: MANY, events: EVENTS });
    const { body } = await callListSessions(handler, {});
    assert.equal(body.items.length, 40);
    assert.equal(body.items[0].title, '标题 s39');
    // 每个会话最多读 2 片（首片命中标题），而非读完 1200 条事件
    for (const h of MANY) {
      assert.ok(stats.readsById[h.id] <= 2, `${h.id} 读了 ${stats.readsById[h.id]} 片，应 ≤2`);
    }
  });

  it('并发读有上限（不得一次性打开全部句柄）', async () => {
    // 用独立 id/updatedAt：titleCache 是模块级的，会跨用例存活，
    // 复用 MANY 会全部命中缓存、一个句柄都不开。
    const headers = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, cwd: '/ws/proj', createdAt: 9000 + i, updatedAt: 9000 + i,
    }));
    const events = Object.fromEntries(headers.map((h) => [h.id, [
      { type: 'user/message', surfaceOp: 'append', data: { content: `t ${h.id}` } },
    ]]));
    const { handler, stats } = makeCountingCtx({ headers, events });
    await callListSessions(handler, {});
    assert.ok(stats.maxConcurrent > 0, '应确实并发读以利用 IO 等待');
    assert.ok(stats.maxConcurrent <= 8, `并发峰值 ${stats.maxConcurrent}，应 ≤8`);
  });

  it('同一 (id,updatedAt) 二次调用不重复打开句柄', async () => {
    const headers = Array.from({ length: 12 }, (_, i) => ({
      id: `k${i}`, cwd: '/ws/proj', createdAt: 7000 + i, updatedAt: 7000 + i,
    }));
    const events = Object.fromEntries(headers.map((h) => [h.id, [
      { type: 'user/message', surfaceOp: 'append', data: { content: `t ${h.id}` } },
    ]]));
    const { handler, stats } = makeCountingCtx({ headers, events });
    const first = await callListSessions(handler, {});
    assert.equal(first.body.items.length, 12);
    const firstOpens = stats.opens;
    assert.ok(firstOpens > 0, '首次应真的读盘');
    const { body } = await callListSessions(handler, {});
    assert.equal(body.items.length, 12);
    assert.equal(stats.opens, firstOpens, '标题缓存应命中，二次调用 opens 不应增加');
  });

  it('updatedAt 变化后缓存失效（改名能反映新标题）', async () => {
    const headers = [{ id: 's1', cwd: '/ws/p', createdAt: 1, updatedAt: 100 }];
    const handler = makeCtx({ headers, archivedIds: [] });
    // 预热缓存（首读拿不到标题，回落到 cwd 派生标题）
    await callListSessions(handler, {});
    const renamed = [{ id: 's1', cwd: '/ws/p', createdAt: 1, updatedAt: 200 }];
    const { handler: h2 } = makeCountingCtx({
      headers: renamed,
      events: { s1: [{ type: 'session/title', data: { title: '新名字' } }] },
    });
    const { body } = await callListSessions(h2, {});
    assert.equal(body.items[0].title, '新名字', 'updatedAt 变化必须重新读事件');
  });
});
