import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 客户端 apply 冒烟测试。
//
// 存在的原因：此前**没有任何测试跑过 apply()**，导致一次 temporal-dead-zone
// 错误（`const inTrash` 被放在其使用点之后）直接上线——`apply` 抛 ReferenceError、
// fiber 被卸载，侧边栏按钮"静默消失"，界面无报错，测试也全绿。
//
// 实现方式：产物顶层只是 `window.__ModuleLoader__.load({ factory })`，
// 直接读源码 + new Function 求值，绕开 CJS/ESM 加载与缓存的差异。
// `require` 是 factory 的入参（DSH 的 ModuleLoader 传入），故无需真实模块系统。

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

function makeReactStub() {
  return {
    createElement: (...a) => ({ type: a[0], props: a[1], children: a[2] }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  };
}

/** 求值产物，取回注册的 factory。 */
function boot() {
  let entry = null;
  const styleNodes = [];
  globalThis.window = {
    __ModuleLoader__: { load: (e) => { entry = e; } },
    innerWidth: 1600,
    innerHeight: 1000,
  };
  // injectStyles 先 querySelector 找已有的 <style data-plugin-css>，找不到才新建。
  // 返回 null 表示"尚无注入"，与真实首跑一致。
  globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    head: { appendChild: (n) => { styleNodes.push(n); return n; } },
    // injectStyles 会 setAttribute('data-plugin-css', …)；dataset 需可写。
    createElement: (tag) => ({
      tag,
      dataset: {},
      setAttribute(k, v) { this.dataset[k.replace(/^data-/, '')] = v; },
      textContent: '',
    }),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  // eslint-disable-next-line no-new-func
  new Function(source)();
  if (!entry) throw new Error('window.__ModuleLoader__.load 未被调用');
  return { entry, styleNodes };
}

/** factory 的 require 入参：react / react-dom 换成替身。 */
function requireStub() {
  const React = makeReactStub();
  return (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (node) => node };
    throw new Error(`unexpected require: ${id}`);
  };
}

function fakeCtx() {
  return {
    effect: (fn) => { fn(); return () => {}; },
    get: (name) => {
      if (name === 'slots') return { inject: () => {}, register: () => ({}) };
      if (name === 'sessions') return { list: { getSnapshot: () => ({}) } };
      if (name === 'uiWorkspace') return { openSession() {} };
      return undefined;
    },
  };
}

function buildModule() {
  const { entry, styleNodes } = boot();
  assert.equal(entry.id, 'dsh-session-browser');
  const mod = entry.factory(requireStub());
  return { mod, styleNodes };
}

describe('客户端 apply 冒烟（捕捉 fiber 级崩溃）', () => {
  it('factory 返回带 apply/inject 的 module', () => {
    const { mod } = buildModule();
    assert.ok(mod, 'factory 应返回 module');
    assert.equal(typeof mod.apply, 'function');
    assert.deepEqual(mod.inject, ['slots', 'sessions', 'uiWorkspace']);
  });

  it('apply 不得抛异常——按钮静默消失就是这里抛了', () => {
    const { mod } = buildModule();
    assert.doesNotThrow(() => mod.apply(fakeCtx()), 'apply 抛错会让侧边栏按钮静默消失');
  });

  it('apply 幂等：重复调用不抛（禁用/启用插件会重来一遍）', () => {
    const { mod } = buildModule();
    const ctx = fakeCtx();
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.doesNotThrow(() => mod.apply(ctx), '重复 apply 也不应抛');
  });

  it('apply 会注入样式节点（面板依赖它布局）', () => {
    const { mod, styleNodes } = buildModule();
    mod.apply(fakeCtx());
    assert.ok(styleNodes.length > 0, 'apply 应向 document.head 注入 <style>');
  });
});
