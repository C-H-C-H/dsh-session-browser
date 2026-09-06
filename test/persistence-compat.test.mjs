import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeaders, readStoredEvents } from '../src/persistence-compat.mjs';

describe('normalizeHeaders', () => {
  it('透传老形状 header 数组', () => {
    const headers = [{ id: 'a', cwd: '/x', createdAt: 1 }];
    assert.deepEqual(normalizeHeaders(headers), headers);
  });
  it('解包新形状 snapshot 数组', () => {
    const out = normalizeHeaders([{ header: { id: 'b', cwd: '/y', createdAt: 2 }, revision: 'r1' }]);
    assert.deepEqual(out, [{ id: 'b', cwd: '/y', createdAt: 2 }]);
  });
  it('过滤无 id 条目', () => {
    assert.deepEqual(normalizeHeaders([null, {}, { header: null }]), []);
  });
});

describe('readStoredEvents', () => {
  it('老后端走 loadStored', async () => {
    const fake = { loadStored: async () => ({ events: [{ type: 'user/message' }] }) };
    assert.deepEqual(await readStoredEvents(fake, 'a'), [{ type: 'user/message' }]);
  });
  it('新后端走 open/read/close 分页读取', async () => {
    const pages = [[{ seq: 0 }], [{ seq: 1 }], []];
    let closed = false;
    const fake = {
      open: async (id, access) => {
        assert.equal(id, 'a'); assert.equal(access, 'read');
        let n = 0;
        return { read: async () => pages[n++], close: async () => { closed = true; } };
      },
    };
    assert.deepEqual(await readStoredEvents(fake, 'a'), [{ seq: 0 }, { seq: 1 }]);
    assert.equal(closed, true);
  });
  it('会话不存在返回 undefined', async () => {
    const fake = { loadStored: async () => undefined };
    assert.equal(await readStoredEvents(fake, 'nope'), undefined);
  });
});
