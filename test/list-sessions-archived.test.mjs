import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.mjs';

// 通过 apply() 注册的 HTTP handler 测 list-sessions（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。

function makeCtx({ headers, archivedIds }) {
  const persistence = {
    list: async () => headers,
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
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
