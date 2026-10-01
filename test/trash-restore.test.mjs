import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, __setTrashPath } from '../lib/index.mjs';

// 回收站（逻辑删除的可撤销记录）：
// delete 抹掉"是否已归档"和"属于哪些工作区"，restore 必须靠 trash 条目补回来。
// attachSession 的硬约束：工作区 path 必须等于会话 header.cwd。

let trashFile = '';

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ssb-trash-'));
  trashFile = join(dir, 'trash.json');
  __setTrashPath(trashFile);
});

after(async () => {
  __setTrashPath(undefined);
  await rm(join(trashFile, '..'), { recursive: true, force: true });
});

/**
 * @param opts.headers  session headers returned by persistence.stat/list
 * @param opts.archived archived set
 * @param opts.workspaces registry entities; each may carry attachSession
 */
function makeCtx({ headers = [], archived = [], workspaces = [], cwdOf = {} } = {}) {
  const store = new Map(headers.map((h) => [h.id, h]));
  const created = [];
  const attachCalls = [];
  const detachCalls = [];
  const entities = workspaces.map((w) => ({
    id: w.id,
    path: w.path,
    sessionIds: w.sessionIds ?? [],
    attachSession: async (sid) => { attachCalls.push([w.id, sid]); },
    detachSession: async (sid) => { detachCalls.push([w.id, sid]); },
  }));
  const archiveCalls = [];
  const persistence = {
    list: async () => [...store.values()],
    // 真实 API：stat() 返回 SessionPersistenceSnapshot `{ header, revision }`，
    // 不是 header 本身（session-persistence/src/index.ts:50）。fake 必须照此形状，
    // 否则插件读 `.cwd` 拿到 undefined，测试却全绿。
    stat: async (id) => {
      const h = store.get(id);
      return h === undefined ? undefined : { header: h, revision: 'r1' };
    },
    open: async (id) => ({
      // offset 是事件索引，读方按 READ_CHUNK 递增；必须尊重 limit，
      // 否则 offset 一跳到 READ_CHUNK 就返回空数组，读取提前 break。
      read: async (offset, limit) => {
        const all = store.get(id)?.events ?? [];
        return { events: all.slice(offset, offset + (limit ?? 1)) };
      },
      close: async () => {},
    }),
  };
  const registry = {
    list: () => entities,
    requireState: () => ({ archivedSessionIds: archived }),
    archiveSession: async (id) => { archiveCalls.push(id); },
    unarchiveSession: async (id) => { archiveCalls.push(`-${id}`); },
    resolveByPath: async (p) => entities.find((e) => e.path === p),
    create: async (p, title) => {
      const e = { id: `new-${created.length}`, path: p, sessionIds: [], attachSession: async (sid) => { attachCalls.push([e.id, sid]); }, detachSession: async () => {} };
      created.push({ path: p, title, entity: e });
      entities.push(e);
      return e;
    },
  };
  const services = { sessionPersistence: persistence, workspaceRegistry: registry };
  let handler = null;
  const ctx = {
    get: (n) => services[n],
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; } },
  };
  apply(ctx);
  return { handler, attachCalls, detachCalls, archiveCalls, created, entities };
}

async function callApi(handler, method, body) {
  const raw = Buffer.from(JSON.stringify(body ?? {}));
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

async function readTrashFile() {
  try { return JSON.parse(await readFile(trashFile, 'utf8')); } catch { return null; }
}

describe('trash 记录：delete 补元数据', () => {
  it('delete 会写入 trash 条目，含 archived / workspaceIds / cwd', async () => {
    const { handler } = makeCtx({
      headers: [{ id: 's1', cwd: '/ws/proj', createdAt: 10, updatedAt: 20 }],
      archived: ['s1'],
      workspaces: [{ id: 'w1', path: '/ws/proj', sessionIds: ['s1'] }],
    });
    const { body } = await callApi(handler, 'delete', { sessionId: 's1' });
    assert.equal(body.ok, true);
    assert.equal(body.result.trashRecorded, true);

    const trash = await readTrashFile();
    assert.ok(trash, 'trash 文件应已创建');
    assert.equal(trash.length, 1);
    assert.equal(trash[0].sessionId, 's1');
    assert.equal(trash[0].archived, true, '归档态必须被记下，否则恢复后不知该放哪个页签');
    assert.deepEqual(trash[0].workspaceIds, ['w1']);
    assert.equal(trash[0].cwd, '/ws/proj');
    assert.ok(trash[0].deletedAt > 0);
  });

  it('未归档会话的 archived 记为 false', async () => {
    const { handler } = makeCtx({
      headers: [{ id: 's2', cwd: '/ws/p2', createdAt: 1, updatedAt: 2 }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/p2', sessionIds: ['s2'] }],
    });
    await callApi(handler, 'delete', { sessionId: 's2' });
    const trash = await readTrashFile();
    assert.equal(trash[0].archived, false);
  });

  it('重复 delete 同一会话只保留一条（后者在前）', async () => {
    const { handler } = makeCtx({
      headers: [
        { id: 's1', cwd: '/ws/a', createdAt: 1, updatedAt: 1 },
        { id: 's2', cwd: '/ws/b', createdAt: 2, updatedAt: 2 },
      ],
      archived: [],
      workspaces: [],
    });
    await callApi(handler, 'delete', { sessionId: 's1' });
    await callApi(handler, 'delete', { sessionId: 's2' });
    await callApi(handler, 'delete', { sessionId: 's1' });
    const trash = await readTrashFile();
    assert.equal(trash.length, 2, '不应出现重复条目');
    assert.equal(trash[0].sessionId, 's1', '最近一次删除应排在最前');
  });
});

describe('list-deleted', () => {
  it('返回 trash 条目并带出标题', async () => {
    const { handler } = makeCtx({
      headers: [{
        id: 's1', cwd: '/ws/proj', createdAt: 10, updatedAt: 20,
        events: [{ type: 'user/message', surfaceOp: 'append', data: { content: '我的会话' } }],
      }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/proj', sessionIds: ['s1'] }],
    });
    await callApi(handler, 'delete', { sessionId: 's1' });
    const { body } = await callApi(handler, 'list-deleted', {});
    assert.equal(body.ok, true);
    assert.equal(body.result.items.length, 1);
    assert.equal(body.result.items[0].sessionId, 's1');
    assert.equal(body.result.items[0].title, '我的会话');
  });

  it('无 trash 文件时返回空列表而不是报错', async () => {
    const { handler } = makeCtx();
    const { status, body } = await callApi(handler, 'list-deleted', {});
    assert.equal(status, 200);
    assert.deepEqual(body.result.items, []);
  });
});

describe('restore', () => {
  it('挂回原工作区并恢复归档态，随后从 trash 移除', async () => {
    const { handler, attachCalls, archiveCalls } = makeCtx({
      headers: [{ id: 's1', cwd: '/ws/proj', createdAt: 10, updatedAt: 20 }],
      archived: ['s1'],
      workspaces: [{ id: 'w1', path: '/ws/proj', sessionIds: [] }],
    });
    await callApi(handler, 'delete', { sessionId: 's1' });
    const { body } = await callApi(handler, 'restore', { sessionId: 's1' });

    assert.equal(body.ok, true);
    assert.equal(body.result.restored, true);
    assert.equal(body.result.archived, true);
    assert.deepEqual(attachCalls, [['w1', 's1']], '应挂回原工作区');
    assert.ok(archiveCalls.includes('s1'), '原本已归档的应恢复归档态');
    const trash = await readTrashFile();
    assert.equal(trash.length, 0, '恢复后应从 trash 移除');
  });

  it('原工作区不存在时按会话 cwd 重建工作区（不塞进人造容器）', async () => {
    const { handler, attachCalls, created } = makeCtx({
      headers: [{ id: 's1', cwd: '/ws/proj', createdAt: 10, updatedAt: 20 }],
      archived: [],
      workspaces: [], // 原工作区已消失
    });
    await callApi(handler, 'delete', { sessionId: 's1' });
    const { body } = await callApi(handler, 'restore', { sessionId: 's1' });

    assert.equal(body.ok, true);
    assert.equal(body.result.cwd, '/ws/proj');
    assert.equal(created.length, 1, '应按会话自己的 cwd 建工作区');
    assert.equal(created[0].path, '/ws/proj');
    assert.deepEqual(attachCalls, [['new-0', 's1']]);
  });

  it('未归档会话恢复后不调用 archiveSession', async () => {
    const { handler, archiveCalls } = makeCtx({
      headers: [{ id: 's2', cwd: '/ws/p2', createdAt: 1, updatedAt: 2 }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/p2', sessionIds: [] }],
    });
    await callApi(handler, 'delete', { sessionId: 's2' });
    const { body } = await callApi(handler, 'restore', { sessionId: 's2' });
    assert.equal(body.ok, true);
    assert.equal(body.result.archived, false);
    assert.ok(!archiveCalls.includes('s2'), '不应把未归档会话变成已归档');
  });

  it('会话文件已丢失时报 artifacts-missing，且不静默改挂别处', async () => {
    const { handler, attachCalls } = makeCtx({
      headers: [], // 文件已不在
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/proj', sessionIds: [] }],
    });
    await callApi(handler, 'delete', { sessionId: 'ghost' });
    const { body } = await callApi(handler, 'restore', { sessionId: 'ghost' });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'artifacts-missing');
    assert.deepEqual(attachCalls, [], '文件没了就不该做任何挂载');
  });

  it('attachSession 抛错时如实上报 attach-failed', async () => {
    const { handler, entities } = makeCtx({
      headers: [{ id: 's1', cwd: '/ws/proj', createdAt: 1, updatedAt: 1 }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/proj', sessionIds: ['s1'] }],
    });
    // 让恢复时的 attach 失败：目标工作区拒绝挂载
    const target = entities.find(e => e.id === 'w1');
    target.attachSession = async () => { throw new Error('cwd mismatch'); };
    await callApi(handler, 'delete', { sessionId: 's1' });
    const { body } = await callApi(handler, 'restore', { sessionId: 's1' });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'attach-failed');
    assert.match(String(body.detail), /cwd mismatch/, '失败原因要透出给用户');
  });

  it('不在 trash 中的会话返回 not-in-trash', async () => {
    const { handler } = makeCtx();
    const { body } = await callApi(handler, 'restore', { sessionId: 'nope' });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not-in-trash');
  });

  it('缺 sessionId 返回错误', async () => {
    const { handler } = makeCtx();
    const { status, body } = await callApi(handler, 'restore', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

describe('已删除会话不应出现在其他页签', () => {
  // delete 是逻辑删除：日志仍在磁盘上，persistence.list() 照样返回它。
  // 但它已被 detach 出所有记账，于是「未分组 = 全部 − 有归属」会把它捞进来，
  // 导致同一个会话同时出现在「未分组」和「已删除」两个页签。
  it('删除后 list-sessions 不再返回该会话（未归档/未分组页都不出现）', async () => {
    const { handler } = makeCtx({
      headers: [{ id: 'g1', cwd: '/ws/p', createdAt: 1, updatedAt: 1 }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/p', sessionIds: ['g1'] }],
    });
    const before = await callApi(handler, 'list-sessions', {});
    assert.deepEqual(before.body.items.map(i => i.sessionId), ['g1']);

    await callApi(handler, 'delete', { sessionId: 'g1' });

    const after = await callApi(handler, 'list-sessions', {});
    assert.deepEqual(after.body.items.map(i => i.sessionId), [],
      '已删除的会话不得再出现在未归档页');
    const ungrouped = await callApi(handler, 'list-sessions', { ungrouped: true });
    assert.deepEqual(ungrouped.body.items.map(i => i.sessionId), [],
      '已删除的会话不得掉进未分组页');
  });

  it('未删除但无归属的会话仍应出现在未分组页（别误伤）', async () => {
    const { handler } = makeCtx({
      headers: [{ id: 'u1', cwd: '/other', createdAt: 1, updatedAt: 1 }],
      archived: [],
      workspaces: [],
    });
    const { body } = await callApi(handler, 'list-sessions', { ungrouped: true });
    assert.deepEqual(body.items.map(i => i.sessionId), ['u1']);
  });

  it('恢复后该会话重新出现在未归档页', async () => {
    const { handler } = makeCtx({
      headers: [{ id: 'g1', cwd: '/ws/p', createdAt: 1, updatedAt: 1 }],
      archived: [],
      workspaces: [{ id: 'w1', path: '/ws/p', sessionIds: ['g1'] }],
    });
    await callApi(handler, 'delete', { sessionId: 'g1' });
    await callApi(handler, 'restore', { sessionId: 'g1' });
    const after = await callApi(handler, 'list-sessions', {});
    assert.deepEqual(after.body.items.map(i => i.sessionId), ['g1'],
      '恢复后应重新可见，否则用户会以为恢复失败');
    const ungrouped = await callApi(handler, 'list-sessions', { ungrouped: true });
    assert.deepEqual(ungrouped.body.items.map(i => i.sessionId), []);
  });
});

describe('已删除列表的标题（session/title 落在日志末尾）', () => {
  // titleCache 是模块级的，会跨用例存活；下面两个用例必须用彼此独立的
  // id/updatedAt，否则会命中前一个用例缓存的空标题，测出假结果。
  it('重命名过的会话显示 durable 标题，而非首条用户消息', async () => {
    // session/title 是用户重命名时追加的，位于日志靠后位置。
    // 若沿用「见到首条 user/message 就停」的限读路径，标题会退化成消息内容。
    const events = [
      { type: 'session', seq: 0, data: {} },
      { type: 'user/message', seq: 1, surfaceOp: 'append', data: { content: '你好' } },
      { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { content: '…' } },
      { type: 'session/title', seq: 3, data: { title: '打招呼与问候开场' } },
    ];
    const { handler } = makeCtx({
      headers: [{ id: 'ttl-a', cwd: '/ws/proj-a', createdAt: 9101, updatedAt: 9101, events }],
      archived: [],
      workspaces: [{ id: 'wa', path: '/ws/proj-a', sessionIds: ['ttl-a'] }],
    });
    await callApi(handler, 'delete', { sessionId: 'ttl-a' });
    const { body } = await callApi(handler, 'list-deleted', {});
    assert.equal(body.result.items[0].title, '打招呼与问候开场',
      '必须读到日志末尾的 session/title，而不是首条消息「你好」');
  });

  it('从未重命名的会话仍回退到首条用户消息', async () => {
    const events = [
      { type: 'session', seq: 0, data: {} },
      { type: 'user/message', seq: 1, surfaceOp: 'append', data: { content: '随便问一句' } },
    ];
    const { handler } = makeCtx({
      headers: [{ id: 'ttl-b', cwd: '/ws/proj-b', createdAt: 9202, updatedAt: 9202, events }],
      archived: [],
      workspaces: [{ id: 'wb', path: '/ws/proj-b', sessionIds: ['ttl-b'] }],
    });
    await callApi(handler, 'delete', { sessionId: 'ttl-b' });
    const { body } = await callApi(handler, 'list-deleted', {});
    assert.equal(body.result.items[0].title, '随便问一句');
  });
});

describe('cwd 采集（stat 返回的是 snapshot 而非 header）', () => {
  it('delete 记录到的 cwd 来自 stat().header.cwd', async () => {
    // 回归：插件曾直接读 stat() 返回值的 `.cwd`，而真实 API 返回
    // `{ header, revision }`，于是 cwd 恒为 ''，restore 必然 `no-cwd`。
    const { handler } = makeCtx({
      headers: [{ id: 'cw1', cwd: 'D:\\workspace', createdAt: 111, updatedAt: 222 }],
      archived: [],
      workspaces: [{ id: 'w1', path: 'D:\\workspace', sessionIds: ['cw1'] }],
    });
    await callApi(handler, 'delete', { sessionId: 'cw1' });
    const trash = await readTrashFile();
    assert.equal(trash[0].cwd, 'D:\\workspace', 'cwd 必须来自 snapshot.header');
    assert.equal(trash[0].createdAt, 111);
    assert.equal(trash[0].updatedAt, 222);
  });

  it('删除后可成功恢复（cwd 非空才进得了恢复路径）', async () => {
    const { handler, attachCalls } = makeCtx({
      headers: [{ id: 'cw2', cwd: '/ws/proj', createdAt: 5, updatedAt: 6 }],
      archived: [],
      workspaces: [{ id: 'w2', path: '/ws/proj', sessionIds: [] }],
    });
    await callApi(handler, 'delete', { sessionId: 'cw2' });
    const { body } = await callApi(handler, 'restore', { sessionId: 'cw2' });
    assert.equal(body.ok, true, `应恢复成功，实际 error=${body.error}`);
    assert.deepEqual(attachCalls, [['w2', 'cw2']]);
  });
});

describe('trash 文件健壮性', () => {
  it('损坏的 JSON 读作空列表，不抛错', async () => {
    await writeFile(trashFile, '{ this is not json', 'utf8');
    const { handler } = makeCtx();
    const { body } = await callApi(handler, 'list-deleted', {});
    assert.equal(body.ok, true);
    assert.deepEqual(body.result.items, []);
  });

  it('条目缺字段时补默认值而非 undefined', async () => {
    await writeFile(trashFile, JSON.stringify([{ sessionId: 'x' }]), 'utf8');
    const { handler } = makeCtx();
    const { body } = await callApi(handler, 'list-deleted', {});
    const item = body.result.items[0];
    assert.equal(item.sessionId, 'x');
    assert.equal(item.archived, false);
    assert.equal(item.cwd, '');
    assert.deepEqual(body.result.items[0].workspaceIds ?? [], []);
  });
});
