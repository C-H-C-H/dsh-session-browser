import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.mjs';

// Task 2：list-rounds round 项补 messageId（跳转锚点用）。
// mock persistence.open 返回事件，断言 items[0].messageId === 'm-1'、
// items[1].messageId === undefined。

const EVENTS = [
  { seq: 1, type: 'user/message', time: 1000, data: { id: 'm-1', content: 'hello' } },
  { seq: 2, type: 'user/message', time: 2000, data: { content: 'no id here' } },
];

function makeHandler() {
  const persistence = {
    list: async () => [],
    open: async () => {
      let done = false;
      return {
        read: async () => {
          if (done) return { events: [] };
          done = true;
          return { events: EVENTS };
        },
        close: async () => {},
      };
    },
  };
  const services = { sessionPersistence: persistence };
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

async function callListRounds(handler, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    url: '/session-browser/api/list-rounds',
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

describe('list-rounds messageId', () => {
  it('有 string id 的 round 带 messageId，无 id 的为 undefined', async () => {
    const handler = makeHandler();
    const { status, body } = await callListRounds(handler, { sessionId: 's-1' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].messageId, 'm-1');
    assert.equal(body.items[1].messageId, undefined);
  });

  it('有 string id 的 round 带引擎 anchorKey，无 id 的为 undefined', async () => {
    const handler = makeHandler();
    const { body } = await callListRounds(handler, { sessionId: 's-1' });
    assert.equal(body.items[0].anchorKey, '13:input-messagem-1');
    assert.equal(body.items[1].anchorKey, undefined);
  });
});
