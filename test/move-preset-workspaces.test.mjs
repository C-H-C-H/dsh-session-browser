import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject } from '../lib/index.mjs';

// Host move / preset-migrate / workspaces（Task 3）：经 apply() 注册的 HTTP handler 测
// `/session-browser/api/move|preset-migrate|workspaces`（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。move 已重写为 fork 式迁移，只用公开脸：
// sessionQuery.observeSession 读源会话、agents.create（回退 sessions.create）建新
// 会话、workspaceRegistry 做记账切换与归档。不再 mock readRaw/loadStored/locate/
// prepare/enter（旧 move 用的已移除能力）。preset-migrate 仍是旧实现（Task 4 的活），
// 其用例经 persistence 选项显式传入旧工件 mock。

function makeEntity(id, dirPath, ids) {
  const record = { sessionIds: [...ids] };
  return {
    id,
    title: `ws-${id}`,
    path: dirPath,
    record,
    get sessionIds() { return record.sessionIds; },
    attachSession: async (sid) => {
      if (!record.sessionIds.includes(sid)) record.sessionIds.unshift(sid);
    },
    detachSession: async (sid) => {
      record.sessionIds = record.sessionIds.filter((x) => x !== sid);
    },
  };
}

// preset-migrate 旧实现（Task 4 重写前）用的工件级 mock：locate 按 meta.cwd
// 定位，list 以文件存在为准，readRaw 从头行重建 meta。move 新实现不用它。
function makeLegacyPersistence(entities, files) {
  const seedDirs = () => [...new Set([
    ...entities.map((e) => e.path),
    ...Object.values(files).map((f) => f.cwd),
  ])];
  const findArtifact = (id) => {
    for (const d of seedDirs()) {
      const p = join(d, id, 'session.jsonl');
      if (existsSync(p)) return p;
    }
    return undefined;
  };
  return {
    locate: (meta) => ({ path: join(meta.cwd, meta.id, 'session.jsonl') }),
    // 真后端按 id 定位工件（不知 cwd）：扫描已知工作区目录 + 种子 cwd，
    // meta.cwd 取自磁盘头行（move 后 loadStored 能找到新位置并返回新 cwd）。
    list: async () => {
      const out = [];
      for (const id of Object.keys(files)) {
        const p = findArtifact(id);
        if (!p) continue;
        const header = JSON.parse(readFileSync(p, 'utf8').split('\n')[0]);
        out.push({ id, cwd: header.cwd, createdAt: 1000 });
      }
      return out;
    },
    readRaw: async (id) => {
      const p = findArtifact(id);
      if (!p) return undefined;
      const content = readFileSync(p, 'utf8');
      return { meta: { id, cwd: JSON.parse(content.split('\n')[0]).cwd }, content };
    },
    loadStored: async (id) => {
      const p = findArtifact(id);
      if (!p) return undefined;
      const content = readFileSync(p, 'utf8');
      const nl = content.indexOf('\n');
      const header = JSON.parse(content.slice(0, nl));
      const events = content.slice(nl + 1).split('\n')
        .filter((l) => l.length > 0).map((l) => JSON.parse(l));
      return { meta: header, events };
    },
    inspect: async () => {},
  };
}

// 新 move 只用公开脸：sessionQuery.observeSession（源会话读取）、agents.create
//（首选）/ sessions.create（回退）、sessions.get/flush + agents.get/cancel/whenIdle
//（live 停止）、workspaceRegistry.list/get/attach/detach/enqueueOperation/
// archiveSession（记账切换与旧会话归档）。
function makeCtx({ entities, presets, observation, observeError, live, noAgentsCreate, persistence }) {
  const state = { archivedSessionIds: [] };
  const created = [];      // agents.create / sessions.create 调用参数（created[0].meta.cwd 即新会话 cwd）
  const observes = [];     // observeSession 调用记录
  const archiveCalls = []; // archiveSession 调用记录（含 stopActivity opts）
  const flushed = [];      // sessions.flush 调用记录
  const cancelled = [];    // agent.cancel 调用记录
  const registry = {
    list: () => entities,
    get: (id) => entities.find((e) => e.id === id),
    requireState: () => state,
    enqueueOperation: async (fn) => fn(),
    setState: async (next) => { Object.assign(state, next); },
    archiveSession: async (id, opts) => {
      if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds.push(id);
      archiveCalls.push([id, opts]);
    },
    unarchiveSession: async (id) => {
      state.archivedSessionIds = state.archivedSessionIds.filter((x) => x !== id);
    },
  };
  const liveAgents = new Map(Object.entries(live?.agents || {}));
  const liveSessions = new Map(Object.entries(live?.sessions || {}));
  const emits = [];
  const sessionQuery = {
    observeSession: async (id, opts) => {
      observes.push([id, opts]);
      if (observeError) throw observeError;
      if (observation === undefined) {
        const err = new Error(`session "${id}" not found`);
        err.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw err;
      }
      const header = observation.header;
      const events = observation.events || [];
      return {
        source: 'prepared',
        header,
        inheritedEventCount: 0,
        events,
        cursor: events.length === 0 ? -1 : events.length - 1,
        [Symbol.dispose]: () => {},
      };
    },
  };
  const services = {
    workspaceRegistry: registry,
    sessionQuery,
    agentPresets: { list: async () => presets || [] },
    ...(persistence === undefined ? {} : { sessionPersistence: persistence }),
  };
  let handler = null;
  const ctx = {
    get: (name) => services[name],
    sessions: {
      get: (id) => liveSessions.get(id),
      flush: async (session) => { flushed.push(session); },
      create: async (opts) => {
        created.push({ via: 'sessions', ...opts });
        return { sessionId: opts.sessionId };
      },
    },
    agents: {
      get: (id) => liveAgents.get(id),
      ...(noAgentsCreate ? {} : {
        create: async (opts) => {
          created.push({ via: 'agents', ...opts });
          return { agent: { id: opts.sessionId } };
        },
      }),
    },
    workspaceRegistry: registry,
    emit: (event, ...args) => { emits.push([event, ...args]); },
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; } },
  };
  apply(ctx);
  assert.ok(handler, 'apply 应注册 /session-browser/api handler');
  return { handler, state, entities, emits, created, observes, archiveCalls, flushed, cancelled };
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

async function realDir(prefix) {
  return realpath(mkdtempSync(join(tmpdir(), prefix)));
}

function writeSession(cwd, id, headerExtra, events) {
  const dir = join(cwd, id);
  mkdirSync(dir, { recursive: true });
  const header = { id, cwd, createdAt: 1000, ...(headerExtra || {}) };
  const lines = [JSON.stringify(header), ...(events || []).map((e) => JSON.stringify(e)), ''].join('\n');
  writeFileSync(join(dir, 'session.jsonl'), lines);
  return { id, cwd };
}

describe('inject', () => {
  it('包含移植代码经 ctx.X 使用的服务 sessions + agents', () => {
    assert.ok(inject.includes('sessions'), 'inject 应包含 sessions（move/migrate 经 ctx.sessions 使用）');
    assert.ok(inject.includes('agents'), 'inject 应包含 agents（quietLive/retire 经 ctx.agents 使用）');
  });
});

describe('workspaces', () => {
  it('返回有序投影 id/name/title/path/sessionCount/sessionIds', async () => {
    const src = await realDir('browser-t3-ws-a-');
    const dst = await realDir('browser-t3-ws-b-');
    const { handler } = makeCtx({
      entities: [makeEntity('w1', src, ['s-1', 's-2']), makeEntity('w2', dst, [])],
    });
    const { status, body } = await callApi(handler, 'workspaces', {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.result.workspaces, [
      {
        id: 'w1', name: 'ws-w1', title: 'ws-w1', path: src,
        sessionCount: 2, sessionIds: ['s-1', 's-2'],
      },
      {
        id: 'w2', name: 'ws-w2', title: 'ws-w2', path: dst,
        sessionCount: 0, sessionIds: [],
      },
    ]);
  });
});

describe('move', () => {
  it('move 经 fork 建新会话：目标含新 id、源去旧 id、旧 id 被归档', async () => {
    const src = await realDir('browser-t3-mv-src-');
    const dst = await realDir('browser-t3-mv-dst-');
    const srcEnt = makeEntity('w-src', src, ['s-move']);
    const dstEnt = makeEntity('w-dst', dst, []);
    const seedEvents = [{ seq: 0, type: 'user/message', data: { content: 'hi' } }];
    const { handler, state, created, archiveCalls } = makeCtx({
      entities: [srcEnt, dstEnt],
      observation: { header: { id: 's-move', cwd: src, agentPreset: 'code' }, events: seedEvents },
    });
    const { status, body } = await callApi(handler, 'move', {
      sessionId: 's-move', targetWorkspaceId: 'w-dst',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.moved, true);
    // agents.create 接到建新会话请求：meta.cwd 为目标路径，seed 为源事件，
    // 源会话的 agentPreset 透传到新会话 meta。
    const createResult = created[0];
    assert.ok(createResult, '应调用 agents.create 建新会话');
    assert.equal(createResult.via, 'agents');
    assert.equal(createResult.meta.cwd, dst);
    assert.equal(createResult.meta.agentPreset, 'code');
    assert.deepEqual(createResult.seed, seedEvents);
    // 返回的新 id 即创建时用的 id。
    assert.equal(body.result.newSessionId, createResult.sessionId);
    assert.equal(body.result.sessionId, createResult.sessionId);
    // 记账切换：目标含新 id，源不再含旧 id。
    assert.ok(dstEnt.record.sessionIds.includes(body.result.newSessionId), '目标工作区应包含新 id');
    assert.ok(!srcEnt.record.sessionIds.includes('s-move'), '源工作区应不再包含旧 id');
    assert.deepEqual(body.result.fromWorkspaceIds, ['w-src']);
    assert.equal(body.result.toWorkspaceId, 'w-dst');
    assert.equal(body.result.toWorkspaceTitle, 'ws-w-dst');
    // 旧会话被归档保留（含 stopActivity 停止请求）。
    assert.ok(state.archivedSessionIds.includes('s-move'), '旧 id 应被 archive');
    assert.equal(body.result.archivedSourceId, 's-move');
    assert.equal(archiveCalls[0][0], 's-move');
    assert.equal(archiveCalls[0][1]?.stopActivity, true);
    assert.equal(body.result.wasLive, false);
  });

  it('move 经 sessions.create 回退路径同样返回新 id', async () => {
    const src = await realDir('browser-t3-mv-fb-src-');
    const dst = await realDir('browser-t3-mv-fb-dst-');
    const srcEnt = makeEntity('w-src', src, ['s-fb']);
    const dstEnt = makeEntity('w-dst', dst, []);
    const { handler, created } = makeCtx({
      entities: [srcEnt, dstEnt],
      observation: { header: { id: 's-fb', cwd: src }, events: [] },
      noAgentsCreate: true,
    });
    const { body } = await callApi(handler, 'move', {
      sessionId: 's-fb', targetWorkspaceId: 'w-dst',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.moved, true);
    const createResult = created[0];
    assert.ok(createResult, '应回退到 sessions.create 建新会话');
    assert.equal(createResult.via, 'sessions');
    assert.equal(body.result.newSessionId, createResult.sessionId);
    assert.ok(dstEnt.record.sessionIds.includes(body.result.newSessionId));
  });

  it('move 运行中会话：停止 live agent（cancel+whenIdle+flush）且 wasLive:true', async () => {
    const src = await realDir('browser-t3-mv-live-src-');
    const dst = await realDir('browser-t3-mv-live-dst-');
    const srcEnt = makeEntity('w-src', src, ['s-live']);
    const dstEnt = makeEntity('w-dst', dst, []);
    let idleWaited = false;
    const agent = {
      cancelReason: undefined,
      cancel: function (reason) { this.cancelReason = reason; },
      whenIdle: async () => { idleWaited = true; },
    };
    const liveSession = { id: 's-live' };
    const { handler, flushed } = makeCtx({
      entities: [srcEnt, dstEnt],
      observation: { header: { id: 's-live', cwd: src }, events: [] },
      live: { agents: { 's-live': agent }, sessions: { 's-live': liveSession } },
    });
    const { body } = await callApi(handler, 'move', {
      sessionId: 's-live', targetWorkspaceId: 'w-dst',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.wasLive, true);
    assert.deepEqual(agent.cancelReason, { kind: 'disposed' });
    assert.equal(idleWaited, true, '应等待 agent.whenIdle');
    assert.ok(flushed.includes(liveSession), '应 flush live session');
  });

  it('move 已在目标工作区时为 no-op（moved:false，不建新会话）', async () => {
    const dst = await realDir('browser-t3-mv-noop-');
    const ent = makeEntity('w-dst', dst, ['s-here']);
    const { handler, created } = makeCtx({
      entities: [ent],
      observation: { header: { id: 's-here', cwd: dst }, events: [] },
    });
    const { body } = await callApi(handler, 'move', {
      sessionId: 's-here', targetWorkspaceId: 'w-dst',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.moved, false);
    assert.equal(body.result.message, '会话已属于目标工作区');
    assert.equal(created.length, 0, 'no-op 不应创建新会话');
  });

  it('move 缺少 sessionId / targetWorkspaceId 返回 ok:false', async () => {
    const { handler } = makeCtx({ entities: [] });
    const noSid = await callApi(handler, 'move', { targetWorkspaceId: 'w' });
    assert.equal(noSid.body.ok, false);
    assert.equal(noSid.body.error, 'sessionId 必填');
    const noTarget = await callApi(handler, 'move', { sessionId: 's' });
    assert.equal(noTarget.body.ok, false);
    assert.equal(noTarget.body.error, 'targetWorkspaceId 必填');
  });

  it('move 未知目标工作区返回中文错误', async () => {
    const dir = await realDir('browser-t3-mv-err-');
    const { handler } = makeCtx({
      entities: [makeEntity('w1', dir, [])],
      observation: { header: { id: 's-x', cwd: dir }, events: [] },
    });
    const badTarget = await callApi(handler, 'move', {
      sessionId: 's-x', targetWorkspaceId: 'w-nope',
    });
    assert.equal(badTarget.body.ok, false);
    assert.match(badTarget.body.error, /目标工作区不存在/);
  });

  it('move 源会话不存在（observeSession 失败）返回中文错误', async () => {
    const dir = await realDir('browser-t3-mv-ghost-');
    const { handler, created } = makeCtx({
      entities: [makeEntity('w1', dir, [])],
    });
    const noSource = await callApi(handler, 'move', {
      sessionId: 's-ghost', targetWorkspaceId: 'w1',
    });
    assert.equal(noSource.body.ok, false);
    assert.match(noSource.body.error, /不存在/);
    assert.equal(created.length, 0, '源不存在时不应创建新会话');
  });

  it('move 子代理（subagent）会话被拒绝', async () => {
    const src = await realDir('browser-t3-mv-sub-src-');
    const dst = await realDir('browser-t3-mv-sub-dst-');
    const { handler, created } = makeCtx({
      entities: [makeEntity('w-src', src, ['s-sub']), makeEntity('w-dst', dst, [])],
      observation: { header: { id: 's-sub', cwd: src, origin: 'subagent' }, events: [] },
    });
    const { body } = await callApi(handler, 'move', {
      sessionId: 's-sub', targetWorkspaceId: 'w-dst',
    });
    assert.equal(body.ok, false);
    assert.match(body.error, /子代理/);
    assert.equal(created.length, 0, '拒绝后不应创建新会话');
  });
});

describe('preset-migrate', () => {
  it('migrate 生效：工件头行 preset 被改写', async () => {
    const dir = await realDir('browser-t3-pm-');
    writeSession(dir, 's-p', { agentPreset: 'a' }, []);
    const entities = [makeEntity('w1', dir, ['s-p'])];
    const files = { 's-p': { id: 's-p', cwd: dir } };
    const { handler } = makeCtx({
      entities,
      files,
      persistence: makeLegacyPersistence(entities, files),
      presets: [{ id: 'a' }, { id: 'b' }],
    });
    const { status, body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-p', toPreset: 'b',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, {
      sessionId: 's-p', migrated: true, oldPreset: 'a', newPreset: 'b',
    });
    const newHeader = JSON.parse(readFileSync(join(dir, 's-p', 'session.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(newHeader.agentPreset, 'b', '头行 agentPreset 应改写为目标预设');
  });

  it('migrate 同预设为 no-op（migrated:false）', async () => {
    const dir = await realDir('browser-t3-pm-noop-');
    writeSession(dir, 's-q', { agentPreset: 'a' }, []);
    const entities = [makeEntity('w1', dir, ['s-q'])];
    const files = { 's-q': { id: 's-q', cwd: dir } };
    const { handler } = makeCtx({
      entities,
      files,
      persistence: makeLegacyPersistence(entities, files),
      presets: [{ id: 'a' }, { id: 'b' }],
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-q', toPreset: 'a',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.migrated, false);
  });

  it('migrate 缺少参数 / 未知预设返回 ok:false', async () => {
    const { handler } = makeCtx({ entities: [], presets: [{ id: 'a' }] });
    const missing = await callApi(handler, 'preset-migrate', { sessionId: 's' });
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error, 'sessionId and toPreset required');
    const unknown = await callApi(handler, 'preset-migrate', {
      sessionId: 's', toPreset: 'zzz',
    });
    assert.equal(unknown.body.ok, false);
    assert.match(unknown.body.error, /Agent 预设 "zzz" 不存在/);
  });
});
