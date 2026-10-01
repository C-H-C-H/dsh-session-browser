import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.mjs';

// Host archive / unarchive / delete：经 apply() 注册的 HTTP handler 测
// `/session-browser/api/archive|unarchive|delete`（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。有意不断言 inject 数组内容。
//
// delete 是逻辑删除（Task 5）：停止 live agent（cancel + whenIdle + flush）→
// entry.detach（无 live 行则显式广播 session/disposed）→ 工作区记账 detach →
// 官方 unarchiveSession 清归档成员 → persistence.stat 存在性确认（best-effort）。
// 物理工件由后端持有：host 不调 persistence.locate（0.1.7 已移除），不碰文件系统。

function makeStore(ids) {
  // 纯内存 header 表：list 按未删除 id 返回 header，
  // stat 按删除集合返回 header 或 undefined。
  const store = new Map();
  for (const id of ids) {
    store.set(id, { id, cwd: `/tmp/browser-proj-${id}`, createdAt: 1000, updatedAt: 1000 });
  }
  return store;
}

function makeCtx({ ids, archivedIds, live, agentHasWhenIdle = true }) {
  const store = makeStore(ids);
  const deleted = new Set();
  const state = { archivedSessionIds: [...archivedIds] };
  const wsSessionIds = [...ids];
  const detachedCalls = [];
  const entity = {
    id: 'w1',
    sessionIds: wsSessionIds,
    detachSession: async (sid) => {
      detachedCalls.push(sid);
      const at = wsSessionIds.indexOf(sid);
      if (at >= 0) wsSessionIds.splice(at, 1);
    },
  };
  const registry = {
    list: () => [entity],
    requireState: () => state,
    enqueueOperation: async (fn) => fn(),
    setState: async (next) => { Object.assign(state, next); },
    // workspaceRegistry 官方方法（0.1.7）：host 改调 registry.archiveSession /
    // registry.unarchiveSession，不再手工 enqueueOperation + setState。
    archiveSession: async (sid) => {
      if (state.archivedSessionIds.includes(sid)) return;
      state.archivedSessionIds = [...state.archivedSessionIds, sid];
    },
    unarchiveSession: async (sid) => {
      if (!state.archivedSessionIds.includes(sid)) return;
      state.archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sid);
    },
  };
  const statCalls = [];
  const persistence = {
    list: async () => [...store.values()].filter((h) => !deleted.has(h.id)),
    stat: async (sid) => {
      statCalls.push(sid);
      return deleted.has(sid) ? undefined : store.get(sid);
    },
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
  };
  const services = { sessionPersistence: persistence, workspaceRegistry: registry };
  const entryDetachCalls = [];
  const cancelCalls = [];
  const whenIdleCalls = [];
  const flushCalls = [];
  if (live) {
    services.sessions = {
      get: (sid) => (sid === live ? { id: sid } : undefined),
      flush: async (session) => { flushCalls.push(session); },
      store: {
        get: (sid) => (sid === live
          ? { detach: () => { entryDetachCalls.push(sid); } }
          : undefined),
      },
    };
    services.agents = {
      // whenIdle() 是 Agent 实例方法（dsh-agent runtime-types），不是 agents 服务方法。
      // 挂到实例上才是真实形态；挂在服务上会掩盖"调用方写错接收者"这类缺陷。
      get: (sid) => (sid === live
        ? {
            cancel: (opts) => { cancelCalls.push([sid, opts]); },
            ...(agentHasWhenIdle
              ? { whenIdle: async () => { whenIdleCalls.push(sid); } }
              : {}),
          }
        : undefined),
    };
  }
  const emits = [];
  const ctxExtras = {
    store, deleted, state, wsSessionIds, detachedCalls, emits,
    entryDetachCalls, cancelCalls, whenIdleCalls, flushCalls, statCalls,
  };
  let handler = null;
  const ctx = {
    get: (name) => services[name],
    emit: (event, payload) => { emits.push([event, payload]); },
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; } },
  };
  apply(ctx);
  assert.ok(handler, 'apply 应注册 /session-browser/api handler');
  return { handler, ...ctxExtras };
}

async function callApi(handler, method, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    url: `/session-browser/api/${method}`,
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

describe('archive / unarchive', () => {
  it('archive 翻转归档态：id 进入 archivedIds', async () => {
    const { handler, state } = makeCtx({ ids: ['s-a', 's-b'], archivedIds: [] });
    const { status, body } = await callApi(handler, 'archive', { sessionId: 's-a' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.ok(state.archivedSessionIds.includes('s-a'), 's-a 应进入 archivedSessionIds');

    const archived = await callApi(handler, 'list-sessions', { archived: true });
    assert.ok(archived.body.items.map((i) => i.sessionId).includes('s-a'));
    const active = await callApi(handler, 'list-sessions', {});
    assert.ok(!active.body.items.map((i) => i.sessionId).includes('s-a'));
  });

  it('archive 缺少 sessionId 返回 ok:false', async () => {
    const { handler } = makeCtx({ ids: ['s-a'], archivedIds: [] });
    const { body } = await callApi(handler, 'archive', {});
    assert.equal(body.ok, false);
    assert.equal(body.error, 'sessionId 必填');
  });

  it('unarchive 移除归档态', async () => {
    const { handler, state } = makeCtx({ ids: ['s-a', 's-b'], archivedIds: ['s-a'] });
    const { status, body } = await callApi(handler, 'unarchive', { sessionId: 's-a' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.ok(!state.archivedSessionIds.includes('s-a'), 's-a 应移出 archivedSessionIds');

    const active = await callApi(handler, 'list-sessions', {});
    assert.ok(active.body.items.map((i) => i.sessionId).includes('s-a'));
  });

  it('unarchive 未知 id 幂等 ok:true（与会话管理一致）', async () => {
    const { handler } = makeCtx({ ids: ['s-a'], archivedIds: [] });
    const { body } = await callApi(handler, 'unarchive', { sessionId: 'nope' });
    assert.deepEqual(body, { ok: true });
  });
});

describe('delete', () => {
  it('delete 后会话不再出现在 list() 输出（含归档成员与工作区记账一并清除）', async () => {
    const { handler, state, wsSessionIds, statCalls } = makeCtx({
      ids: ['s-del', 's-keep'], archivedIds: ['s-del'],
    });

    const { status, body } = await callApi(handler, 'delete', { sessionId: 's-del' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result?.deleted, true);
    assert.equal(body.result?.artifactRemoved, false);
    assert.ok(!state.archivedSessionIds.includes('s-del'), '归档集成员应一并清除');
    assert.ok(!wsSessionIds.includes('s-del'), '工作区记账应 detach');
    assert.ok(statCalls.includes('s-del'), '应经 stat 确认存在');

    const { body: listBody } = await callApi(handler, 'list-sessions', {});
    const listIds = listBody.items.map((i) => i.sessionId);
    assert.ok(!listIds.includes('s-del'), '删除后 list() 不应再包含该会话');
    assert.ok(listIds.includes('s-keep'));
  });

  it('delete 存活会话先停 agent 再 detach（cancel + entry.detach 被调用）', async () => {
    const { handler, entryDetachCalls, cancelCalls, whenIdleCalls, flushCalls } = makeCtx({
      ids: ['s-live'], archivedIds: [], live: 's-live',
    });
    const { body } = await callApi(handler, 'delete', { sessionId: 's-live' });
    assert.equal(body.ok, true);
    assert.deepEqual(cancelCalls, [['s-live', { kind: 'disposed' }]]);
    assert.deepEqual(whenIdleCalls, ['s-live'], '必须在 Agent 实例上调 whenIdle');
    assert.equal(flushCalls.length, 1);
    assert.deepEqual(entryDetachCalls, ['s-live']);
    assert.equal(body.result?.deleted, true);
    assert.equal(body.result?.wasLive, true);
    assert.equal(body.result?.detached, true);
  });

  it('delete 时 agent 实例也没有 whenIdle 仍应成功（防御性，不崩）', async () => {
    const { handler, whenIdleCalls, entryDetachCalls } = makeCtx({
      ids: ['s-live'], archivedIds: [], live: 's-live', agentHasWhenIdle: false,
    });
    const { body } = await callApi(handler, 'delete', { sessionId: 's-live' });
    assert.equal(body.ok, true);
    assert.deepEqual(whenIdleCalls, [], '实例没有该方法时不应调用');
    assert.deepEqual(entryDetachCalls, ['s-live'], '仍应走完 detach 流程');
    assert.equal(body.result?.detached, true);
  });

  it('delete 无存活条目时广播 session/disposed（客户端清行）', async () => {
    const { handler, emits, statCalls } = makeCtx({ ids: ['s-gone'], archivedIds: [] });
    const { body } = await callApi(handler, 'delete', { sessionId: 's-gone' });
    assert.equal(body.ok, true);
    assert.equal(body.result?.deleted, true);
    assert.equal(body.result?.wasLive, false);
    assert.ok(
      emits.some(([event, payload]) => event === 'session/disposed' && payload?.id === 's-gone'),
      '应 emit session/disposed 让各客户端丢弃该行',
    );
    assert.ok(statCalls.includes('s-gone'), '应经 stat 确认存在');
  });

  it('delete 缺少 sessionId 返回 ok:false', async () => {
    const { handler } = makeCtx({ ids: ['s-a'], archivedIds: [] });
    const { body } = await callApi(handler, 'delete', {});
    assert.equal(body.ok, false);
    assert.equal(body.error, 'sessionId 必填');
  });
});
