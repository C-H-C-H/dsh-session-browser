import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWindowCovers, withTimeout } from '../src/jump-loader.mjs';

const instant = () => Promise.resolve();

describe('ensureWindowCovers', () => {
  it('经 scope/sessionOf 调 loadThrough 并返回 true', async () => {
    let gotSeq;
    const scoped = {};
    const sessions = {
      scope: (id) => { assert.equal(id, 's'); return scoped; },
      sessionOf: (c) => { assert.equal(c, scoped); return { loadThrough: async (seq) => { gotSeq = seq; } }; },
    };
    assert.equal(await ensureWindowCovers(sessions, 's', 42, { timeoutMs: 1000, sleep: instant }), true);
    assert.equal(gotSeq, 42);
  });
  it('无 scope 方法返回 false', async () => {
    assert.equal(await ensureWindowCovers({}, 's', 1, { sleep: instant }), false);
    assert.equal(await ensureWindowCovers(null, 's', 1, { sleep: instant }), false);
  });
  it('scope 解析不出时重试后返回 false', async () => {
    let n = 0;
    const sessions = { scope: () => { n++; return undefined; } };
    assert.equal(await ensureWindowCovers(sessions, 's', 1, { timeoutMs: 5000, sleep: instant }), false);
    assert.equal(n, 4);
  });
  it('sessionOf 无结果返回 false', async () => {
    const sessions = { scope: () => ({}), sessionOf: () => undefined };
    assert.equal(await ensureWindowCovers(sessions, 's', 1, { sleep: instant }), false);
  });
  it('无 loadThrough 方法返回 false（2.0.4 回退）', async () => {
    const sessions = { scope: () => ({}), sessionOf: () => ({}) };
    assert.equal(await ensureWindowCovers(sessions, 's', 1, { sleep: instant }), false);
  });
  it('loadThrough 抛错返回 false', async () => {
    const sessions = { scope: () => ({}), sessionOf: () => ({ loadThrough: async () => { throw new Error('nope'); } }) };
    assert.equal(await ensureWindowCovers(sessions, 's', 1, { sleep: instant }), false);
  });
  it('loadThrough 超时返回 false', async () => {
    const sessions = { scope: () => ({}), sessionOf: () => ({ loadThrough: () => new Promise(() => {}) }) };
    assert.equal(await ensureWindowCovers(sessions, 's', 1, { timeoutMs: 10, sleep: instant }), false);
  });
});

describe('withTimeout', () => {
  it('按时 resolve 透传值', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok');
  });
  it('超时 reject', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 10), /timeout/);
  });
});
