import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject } from '../lib/index.mjs';

// Host move / preset-migrate / workspaces（Task 3）：经 apply() 注册的 HTTP handler 测
// `/session-browser/api/move|preset-migrate|workspaces`（src/index.ts 为 TS 源码，
// lib/index.mjs 为手写镜像的可运行产物）。inject 由本 task 拥有，故此处断言
// 移植代码实际经 ctx.X 使用的服务（quietLive / move / retireForPresetMigration
// 使用 ctx.sessions + ctx.agents 属性；sessionPersistence / agentPresets 维持
// ctx.get 懒取，不进 inject）。

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

// 基于真实临时文件的持久化 mock：locate 按 meta.cwd 定位（move 的 re-home
// 断言依赖它），list 以文件存在为准，loadStored 从头行重建 meta。
function makeCtx({ entities, files, presets }) {
  const state = { archivedSessionIds: [] };
  const registry = {
    list: () => entities,
    requireState: () => state,
    enqueueOperation: async (fn) => fn(),
    setState: async (next) => { Object.assign(state, next); },
  };
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
  const persistence = {
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
  const prepared = [];
  const entered = [];
  const emits = [];
  const services = {
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    agentPresets: { list: async () => presets || [] },
  };
  let handler = null;
  const ctx = {
    get: (name) => services[name],
    sessions: {
      get: () => undefined,
      store: { get: () => undefined },
      prepare: (sid, opts) => { prepared.push([sid, opts]); return { id: sid }; },
      enter: (placeholder) => {
        entered.push(placeholder);
        return () => {};
      },
    },
    agents: { get: () => undefined, store: { delete: () => {} } },
    workspaceRegistry: registry,
    emit: (event, ...args) => { emits.push([event, ...args]); },
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; } },
  };
  apply(ctx);
  assert.ok(handler, 'apply 应注册 /session-browser/api handler');
  return { handler, state, entities, emits, prepared };
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
      files: {},
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
  it('move 交换归属：目标工作区含该 id，工件头行 cwd 已更新', async () => {
    const src = await realDir('browser-t3-mv-src-');
    const dst = await realDir('browser-t3-mv-dst-');
    writeSession(src, 's-move', {}, [{ type: 'user/message', data: { content: 'hi' } }]);
    const srcEnt = makeEntity('w-src', src, ['s-move']);
    const dstEnt = makeEntity('w-dst', dst, []);
    const { handler } = makeCtx({
      entities: [srcEnt, dstEnt],
      files: { 's-move': { id: 's-move', cwd: src } },
    });
    const { status, body } = await callApi(handler, 'move', {
      sessionId: 's-move', targetWorkspaceId: 'w-dst',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.moved, true);
    assert.equal(body.result.toWorkspaceId, 'w-dst');
    assert.ok(dstEnt.record.sessionIds.includes('s-move'), '目标工作区应包含该 id');
    assert.ok(!srcEnt.record.sessionIds.includes('s-move'), '源工作区应不再包含该 id');
    const newHeader = JSON.parse(readFileSync(join(dst, 's-move', 'session.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(newHeader.cwd, dst, '工件头行 cwd 应重写为目标路径');
    assert.ok(!existsSync(join(src, 's-move', 'session.jsonl')), '旧工件应已移除');
  });

  it('move 已在目标工作区时为 no-op（moved:false）', async () => {
    const dst = await realDir('browser-t3-mv-noop-');
    writeSession(dst, 's-here', {}, []);
    const ent = makeEntity('w-dst', dst, ['s-here']);
    const { handler } = makeCtx({
      entities: [ent],
      files: { 's-here': { id: 's-here', cwd: dst } },
    });
    const { body } = await callApi(handler, 'move', {
      sessionId: 's-here', targetWorkspaceId: 'w-dst',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.moved, false);
    assert.equal(body.result.message, '会话已属于目标工作区');
  });

  it('move 缺少 sessionId / targetWorkspaceId 返回 ok:false', async () => {
    const { handler } = makeCtx({ entities: [], files: {} });
    const noSid = await callApi(handler, 'move', { targetWorkspaceId: 'w' });
    assert.equal(noSid.body.ok, false);
    assert.equal(noSid.body.error, 'sessionId 必填');
    const noTarget = await callApi(handler, 'move', { sessionId: 's' });
    assert.equal(noTarget.body.ok, false);
    assert.equal(noTarget.body.error, 'targetWorkspaceId 必填');
  });

  it('move 未知目标工作区 / 无磁盘记录返回中文错误', async () => {
    const dir = await realDir('browser-t3-mv-err-');
    const { handler } = makeCtx({
      entities: [makeEntity('w1', dir, [])],
      files: {},
    });
    const badTarget = await callApi(handler, 'move', {
      sessionId: 's-x', targetWorkspaceId: 'w-nope',
    });
    assert.equal(badTarget.body.ok, false);
    assert.match(badTarget.body.error, /目标工作区不存在/);
    const noDisk = await callApi(handler, 'move', {
      sessionId: 's-ghost', targetWorkspaceId: 'w1',
    });
    assert.equal(noDisk.body.ok, false);
    assert.match(noDisk.body.error, /没有磁盘记录/);
  });
});

describe('preset-migrate', () => {
  it('migrate 生效：工件头行 preset 被改写', async () => {
    const dir = await realDir('browser-t3-pm-');
    writeSession(dir, 's-p', { agentPreset: 'a' }, []);
    const { handler } = makeCtx({
      entities: [makeEntity('w1', dir, ['s-p'])],
      files: { 's-p': { id: 's-p', cwd: dir } },
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
    const { handler } = makeCtx({
      entities: [makeEntity('w1', dir, ['s-q'])],
      files: { 's-q': { id: 's-q', cwd: dir } },
      presets: [{ id: 'a' }, { id: 'b' }],
    });
    const { body } = await callApi(handler, 'preset-migrate', {
      sessionId: 's-q', toPreset: 'a',
    });
    assert.equal(body.ok, true);
    assert.equal(body.result.migrated, false);
  });

  it('migrate 缺少参数 / 未知预设返回 ok:false', async () => {
    const { handler } = makeCtx({ entities: [], files: {}, presets: [{ id: 'a' }] });
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
