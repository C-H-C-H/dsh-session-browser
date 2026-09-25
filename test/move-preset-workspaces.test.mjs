import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject } from '../lib/index.mjs';

// Host move / preset-migrate / workspaces（Task 3/4）：经 apply() 注册的 HTTP handler 测
// `/session-browser/api/move|preset-migrate|workspaces`（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。move 是 fork 式迁移，只用公开脸：
// sessionQuery.observeSession 读源会话、agents.create（回退 sessions.create）建新
// 会话、workspaceRegistry 做记账切换与归档。preset-migrate 是官方语义：只用公开脸
// agentPresets.list/select（旧 preset 经 composedPreset/agent ctx 读，
// 回退 sessions.get 的 header）与 agents.get/sessions.get 取 live 对象；不再 mock
// readRaw/loadStored/locate/prepare/enter（已移除能力）。

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

// 新 move / preset-migrate 只用公开脸：sessionQuery.observeSession（源会话读取）、
// agents.create（首选）/ sessions.create（回退）、sessions.get/flush +
// agents.get/cancel/whenIdle（live 对象）、agentPresets.list/select（预设名册与
// 空白会话切换）、workspaceRegistry.list/get/attach/detach/enqueueOperation/
// archiveSession（记账切换与旧会话归档）。
function makeCtx({ entities, presets, observation, observeError, live, noAgentsCreate, persistence, selectImpl, composedPresetImpl }) {
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
  const selectCalls = []; // agentPresets.select 调用记录（preset-migrate 用）
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
    agentPresets: {
      list: async () => presets || [],
      select: async (agent, id) => {
        selectCalls.push([agent, id]);
        if (selectImpl) return selectImpl(agent, id);
        return id;
      },
      ...(composedPresetImpl === undefined ? {} : { composedPreset: composedPresetImpl }),
    },
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
  return { handler, state, entities, emits, created, observes, archiveCalls, flushed, cancelled, selectCalls };
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
  // 官方语义（Task 4）：空白会话走 agentPresets.select，非空白（select 抛
  // agent-preset/locked）拒绝。旧 preset 经 composedPreset/agent ctx 读，
  // 回退 sessions.get 的 live session header。
  it('空白会话走官方 select：migrated:true，newPreset 为 select 返回 id', async () => {
    const agent = { id: 's-p', ctx: {} };
    const { handler, selectCalls } = makeCtx({
      entities: [],
      presets: [{ id: 'a' }, { id: 'b' }],
      live: {
        agents: { 's-p': agent },
        sessions: { 's-p': { id: 's-p', header: { agentPreset: 'a' } } },
      },
    });
    const { status, body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-p', toPreset: 'b',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, {
      sessionId: 's-p', migrated: true, oldPreset: 'a', newPreset: 'b',
    });
    assert.equal(selectCalls.length, 1, '应调用 agentPresets.select');
    assert.equal(selectCalls[0][0], agent, 'select 第一个参数应为 live agent');
    assert.equal(selectCalls[0][1], 'b');
  });

  it('migrate 同预设为 no-op（migrated:false，不调 select）', async () => {
    const agent = { id: 's-q', ctx: {} };
    const { handler, selectCalls } = makeCtx({
      entities: [],
      presets: [{ id: 'a' }, { id: 'b' }],
      live: {
        agents: { 's-q': agent },
        sessions: { 's-q': { id: 's-q', header: { agentPreset: 'a' } } },
      },
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-q', toPreset: 'a',
    });
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, {
      sessionId: 's-q', migrated: false, oldPreset: 'a', newPreset: 'a',
    });
    assert.equal(selectCalls.length, 0, 'no-op 不应调用 select');
  });

  it('migrate 经 composedPreset 读旧预设（优先于 session header）', async () => {
    const agent = { id: 's-c', ctx: {} };
    const { handler, selectCalls } = makeCtx({
      entities: [],
      presets: [{ id: 'a' }, { id: 'b' }],
      live: {
        agents: { 's-c': agent },
        sessions: { 's-c': { id: 's-c', header: { agentPreset: 'stale' } } },
      },
      composedPresetImpl: () => 'a',
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-c', toPreset: 'a',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.migrated, false);
    assert.equal(body.result.oldPreset, 'a');
    assert.equal(selectCalls.length, 0);
  });

  it('migrate 非空白会话：select 抛 agent-preset/locked → ok:false 且 error 含"已开始"', async () => {
    const locked = new Error('This session has already started');
    locked.code = 'agent-preset/locked';
    const { handler } = makeCtx({
      entities: [],
      presets: [{ id: 'a' }, { id: 'b' }],
      live: {
        agents: { 's-busy': { id: 's-busy', ctx: {} } },
        sessions: { 's-busy': { id: 's-busy', header: { agentPreset: 'a' } } },
      },
      selectImpl: () => { throw locked; },
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-busy', toPreset: 'b',
    });
    assert.equal(body.ok, false);
    assert.match(body.error, /已开始/);
  });

  it('migrate 无 live agent 返回 ok:false（含"没有 live agent"）', async () => {
    const { handler, selectCalls } = makeCtx({
      entities: [],
      presets: [{ id: 'a' }, { id: 'b' }],
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-ghost', toPreset: 'b',
    });
    assert.equal(body.ok, false);
    assert.match(body.error, /没有 live agent/);
    assert.equal(selectCalls.length, 0, '无 agent 时不应调用 select');
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
