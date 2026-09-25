import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';

// Host archive / unarchive / delete（Task 2）：经 apply() 注册的 HTTP handler 测
// `/session-browser/api/archive|unarchive|delete`（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。有意不断言 inject 数组内容（Task 3 拥有）。

function makeStore(ids) {
  // 以真实临时目录为工件：persistence.list 以目录存在为准（与磁盘实现一致），
  // delete 的 rm 之后 list() 输出即不再包含该会话。
  const store = new Map();
  for (const id of ids) {
    const dir = mkdtempSync(join(tmpdir(), `browser-t2-${id}-`));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ id }) + '\n');
    store.set(id, {
      header: { id, cwd: join(dir, 'proj'), createdAt: 1000, updatedAt: 1000 },
      dir,
    });
  }
  return store;
}

function makeCtx({ ids, archivedIds, live }) {
  const store = makeStore(ids);
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
  const persistence = {
    list: async () => [...store.values()]
      .filter((v) => existsSync(v.dir))
      .map((v) => v.header),
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
    locate: (meta) => ({ path: join(store.get(meta.id).dir, 'session.jsonl') }),
  };
  const services = { sessionPersistence: persistence, workspaceRegistry: registry };
  const entryDetachCalls = [];
  if (live) {
    services.sessions = {
      get: (sid) => (sid === live ? { id: sid } : undefined),
      flush: async () => {},
      store: {
        get: (sid) => (sid === live
          ? { detach: () => { entryDetachCalls.push(sid); } }
          : undefined),
      },
    };
    services.agents = { get: () => undefined, store: { delete: () => {} } };
  }
  const emits = [];
  const ctxExtras = { store, state, wsSessionIds, detachedCalls, emits, entryDetachCalls };
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
    const { handler, state, store, wsSessionIds } = makeCtx({
      ids: ['s-del', 's-keep'], archivedIds: ['s-del'],
    });
    const dir = store.get('s-del').dir;
    assert.ok(existsSync(dir));

    const { status, body } = await callApi(handler, 'delete', { sessionId: 's-del' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.ok(!existsSync(dir), '工件目录应被 rm 删除');
    assert.ok(!state.archivedSessionIds.includes('s-del'), '归档集成员应一并清除');
    assert.ok(!wsSessionIds.includes('s-del'), '工作区记账应 detach');

    const { body: listBody } = await callApi(handler, 'list-sessions', {});
    const listIds = listBody.items.map((i) => i.sessionId);
    assert.ok(!listIds.includes('s-del'), '删除后 list() 不应再包含该会话');
    assert.ok(listIds.includes('s-keep'));
  });

  it('delete 存活会话先 detach 再删（entry.detach 被调用）', async () => {
    const { handler, entryDetachCalls, store } = makeCtx({
      ids: ['s-live'], archivedIds: [], live: 's-live',
    });
    const { body } = await callApi(handler, 'delete', { sessionId: 's-live' });
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(entryDetachCalls, ['s-live']);
    assert.ok(!existsSync(store.get('s-live').dir));
  });

  it('delete 无存活条目时广播 session/disposed（客户端清行）', async () => {
    const { handler, emits } = makeCtx({ ids: ['s-gone'], archivedIds: [] });
    const { body } = await callApi(handler, 'delete', { sessionId: 's-gone' });
    assert.deepEqual(body, { ok: true });
    assert.ok(
      emits.some(([event, payload]) => event === 'session/disposed' && payload?.id === 's-gone'),
      '应 emit session/disposed 让各客户端丢弃该行',
    );
  });

  it('delete 缺少 sessionId 返回 ok:false', async () => {
    const { handler } = makeCtx({ ids: ['s-a'], archivedIds: [] });
    const { body } = await callApi(handler, 'delete', {});
    assert.equal(body.ok, false);
    assert.equal(body.error, 'sessionId 必填');
  });
});
