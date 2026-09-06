import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchWorkspace } from '../src/workspaces-match.mjs';

describe('matchWorkspace', () => {
  const items = [
    { workspaceId: 'ws1', path: 'D:\\proj\\foo' },
    { workspaceId: 'ws2', path: '/home/u/bar' },
  ];
  it('精确匹配返回 workspaceId key', () => {
    assert.deepEqual(matchWorkspace('D:\\proj\\foo', items), { path: 'D:\\proj\\foo', key: 'ws1' });
  });
  it('子路径前缀匹配（win/posix 分隔符）', () => {
    assert.deepEqual(matchWorkspace('D:\\proj\\foo\\sub', items).key, 'ws1');
    assert.deepEqual(matchWorkspace('/home/u/bar/sub', items).key, 'ws2');
  });
  it('无匹配返回 null，非数组返回 null', () => {
    assert.equal(matchWorkspace('/nowhere', items), null);
    assert.equal(matchWorkspace('/home/u/bar', null), null);
  });
});
