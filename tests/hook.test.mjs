/**
 * dsh-cross-model-bridge - apply() 钩子层集成测试（假 ctx，不依赖 DSH 运行时）
 * 重点覆盖：
 * 1. 事件只在流"完整结束"后提交（中途中止 / 报错都不记录）；
 * 2. 接棒窗口过期后不再注入，但仍持续剥离跨路由的私有推理；
 * 3. 没有跨路由消息时直接透传 next()。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-hook-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ROUTE_A = { kind: 'model', provider: 'pA', model: 'model-A' };
const ROUTE_B = { kind: 'model', provider: 'pB', model: 'model-B' };

const sys = { role: 'system', content: 'sys' };
const user = (text) => ({ role: 'user', content: text });
const assistantA = {
  role: 'assistant',
  source: ROUTE_A,
  content: [
    { type: 'reasoning', text: 'A 的推理：必须使用方案X，避免方案Y。' },
    { type: 'text', text: 'A 的回答' },
  ],
};
const assistantB = { role: 'assistant', source: ROUTE_B, content: [{ type: 'text', text: 'B 的回答' }] };

const toB = (messages) => ({ provider: 'pB', model: 'model-B', sessionId: 's1', messages });
const hasHandoff = (m) => JSON.stringify(m.content ?? '').includes('internal_handoff');
const hasReasoning = (m) =>
  Array.isArray(m.content) && m.content.some((b) => b?.type === 'reasoning' || b?.type === 'thinking');

let seq = 0;

/** 搭一个最小的假 ctx：捕获 llm/stream 拦截器与 /events 处理器，底层 ctx.llm.stream 可替换 */
function createHarness({ config = {}, stream } = {}) {
  const calls = [];
  let streamHandler;
  let eventsHandler;
  const defaultStream = async function* () {
    yield 'c1';
    yield 'c2';
    yield 'c3';
  };

  const ctx = {
    on(evt, fn) {
      if (evt === 'llm/stream') streamHandler = fn;
    },
    logger: { info() {}, warn() {} },
    inject(_deps, cb) {
      cb({ get: () => ({ register: (def) => ((eventsHandler = def.handler), () => {}) }) });
    },
    llm: {
      stream(opts) {
        calls.push(opts);
        return (stream ?? defaultStream)(opts);
      },
    },
  };
  apply(ctx, config, { storageFile: path.join(tmpDir, `events-${++seq}.json`) });

  return {
    calls,
    /** 发起一次请求并消费流；abortAfter 模拟调用方中途中止（for await 里 break） */
    async run(options, { abortAfter } = {}) {
      const chunks = [];
      const gen = streamHandler(options, async function* () {
        yield 'passthrough';
      });
      for await (const chunk of gen) {
        chunks.push(chunk);
        if (abortAfter && chunks.length >= abortAfter) break;
      }
      return chunks;
    },
    async events() {
      let body;
      const url = '/plugins/dsh-cross-model-bridge/events';
      await eventsHandler({ method: 'GET', url }, { writeHead() {}, end: (b) => (body = JSON.parse(b)) });
      return body.events;
    },
  };
}

test('H1. 流完整消费后：出站请求带接棒块，并记录一条事件', async () => {
  const h = createHarness();
  const chunks = await h.run(toB([sys, user('q1'), assistantA, user('q2')]));

  assert.deepEqual(chunks, ['c1', 'c2', 'c3']);
  assert.equal(h.calls.length, 1);
  assert.ok(hasHandoff(h.calls[0].messages[3]), '接棒块挂在切换后的第一条 user 消息上');
  assert.ok(!hasReasoning(h.calls[0].messages[2]), 'A 的私有 reasoning 必须被剥离');

  const events = await h.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'model');
  assert.equal(events[0].target, 'pB / model-B');
  assert.equal(events[0].sessionId, 's1');
});

test('H2. 调用方中途中止（如用户点"停止"）：不记录事件', async () => {
  const h = createHarness();
  const chunks = await h.run(toB([sys, user('q1'), assistantA, user('q2')]), { abortAfter: 1 });

  assert.deepEqual(chunks, ['c1']);
  assert.equal((await h.events()).length, 0, '流没有安全结束，不能提交事件');
});

test('H3. 流中途报错：错误原样抛出，不记录事件', async () => {
  const h = createHarness({
    stream: async function* () {
      yield 'c1';
      throw new Error('429 rate limited');
    },
  });

  await assert.rejects(h.run(toB([sys, user('q1'), assistantA, user('q2')])), /429 rate limited/);
  assert.equal((await h.events()).length, 0);
});

test('H4. 接棒窗口过期后：不再注入、不再记事件，但仍剥离跨路由的私有推理', async () => {
  const h = createHarness(); // keepThinkingTurns 默认 1
  await h.run(toB([sys, user('q1'), assistantA, user('q2'), assistantB, user('q3')]));

  const sent = h.calls[0].messages;
  assert.ok(!sent.some(hasHandoff), '窗口外不再注入接棒块');
  assert.ok(!hasReasoning(sent[2]), 'A 的 reasoning 仍须剥离，否则 B 会收到私有块');
  assert.equal((await h.events()).length, 0);
});

test('H5. 没有跨路由消息时：直接透传 next()，不改写', async () => {
  const h = createHarness();
  const chunks = await h.run(toB([sys, user('q1'), assistantB, user('q2')]));

  assert.deepEqual(chunks, ['passthrough']);
  assert.equal(h.calls.length, 0);
});
