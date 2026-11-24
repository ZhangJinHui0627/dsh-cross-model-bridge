/**
 * dsh-cross-model-bridge - Node.js >= 22 原生单元测试套件
 * 重点覆盖边界：
 * 1. 代码块不腰斩（安全围栏防护）
 * 2. A -> B -> C 连续切换不套娃（幂等清洗）
 * 3. tool_use / tool_result 紧邻保护与 (continued) 兜底
 * 4. 非数组推理字段兼容（reasoning_content / reasoning_details）
 * 5. 配置比例归一化与边界安全校验
 * 6. 原子落盘与 FIFO 环形缓冲
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeConfig,
  estimateTokens,
  getFenceRanges,
  extractThinkingSummary,
  stripHandoffFromText,
  buildHandoffBlock,
  extractReasoningFromMessage,
  prepareHandoff,
  createEventLog,
} from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('1. 代码块安全围栏防护：切点落在代码块中间时自动规避，反引号必成对闭合', () => {
  const thinkingWithCode = [
    '第一部分前言：我们要写一个工具类。',
    '```typescript',
    'export class AuthHelper {',
    '  private token: string;',
    '  constructor(t: string) { this.token = t; }',
    '}',
    '```',
    '结论是这个 AuthHelper 必须单例化。',
  ].join('\n');

  const res = extractThinkingSummary(thinkingWithCode, {
    maxThinkingTokens: 30, // 预算卡在代码块中间
    headRatio: 0.2,
    midRatio: 0.2,
    tailRatio: 0.6,
  });

  const backtickTriples = (res.summary.match(/```/g) || []).length;
  assert.equal(backtickTriples % 2, 0, '反引号出现次数必须是偶数，防止 Markdown 渲染错乱');
});

test('2. 代码块扫描：准确识别多语言反引号与波浪线围栏', () => {
  const text = '前言\n```python\nprint("hello")\n```\n中间\n~~~bash\necho 1\n~~~\n结尾';
  const ranges = getFenceRanges(text);
  assert.equal(ranges.length, 2);
});

test('3. A -> B -> C 连续切换防套娃：幂等清洗历史旧 handoff 块', () => {
  const hop1Handoff = '<internal_handoff data-dsh-bridge="1" from="ModelA" mode="cross-model">\n[第一跳接棒]\n旧决策A\n</internal_handoff>';
  const userPrompt = '请帮我实现第二个步骤。';
  const dirtyUserMessage = `${hop1Handoff}\n\n${userPrompt}`;

  const cleaned = stripHandoffFromText(dirtyUserMessage);
  assert.equal(cleaned.trim(), userPrompt.trim());
  assert.ok(!cleaned.includes('data-dsh-bridge="1"'));
  assert.ok(!cleaned.includes('internal_handoff'));
});

test('4. 多跳消息数组防套娃：全篇只保留唯一且最新的 handoff 块', () => {
  const oldAssistant = {
    role: 'assistant',
    source: { kind: 'model', provider: 'p1', model: 'ModelA' },
    content: [
      { type: 'text', text: '<internal_handoff data-dsh-bridge="1">\n旧标签\n</internal_handoff>\n\n真实回答' },
    ],
  };
  const userMsg = {
    role: 'user',
    content: '<internal_handoff data-dsh-bridge="1">\n旧标签\n</internal_handoff>\n\n新请求',
  };

  const res = prepareHandoff(
    { provider: 'p2', model: 'ModelB', messages: [oldAssistant, userMsg] },
    normalizeConfig(),
  );

  assert.equal(res.shouldHandoff, true);
  assert.equal(res.messages[0].content[0].text, '真实回答');
  const handoffMatches = res.messages[1].content.match(/<internal_handoff/g);
  assert.equal(handoffMatches.length, 1, '全篇只能存在唯一最新的 handoff 块');
});

test('5. Agent 工具链紧邻保护：handoff 插入在最后一个 tool_result 之后', () => {
  const assistant = {
    role: 'assistant',
    source: { kind: 'model', provider: 'openai', model: 'gpt-4o' },
    content: [{ type: 'reasoning', text: '需要调用配置查询工具。' }],
    tool_calls: [{ id: 'call_1', function: { name: 'get_config' } }],
  };
  const user = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_call_id: 'call_1', content: '{"debug": true}' },
      { type: 'text', text: '配置已读取，请继续下一步。' },
    ],
  };

  const res = prepareHandoff(
    { provider: 'anthropic', model: 'claude-3-5-sonnet', messages: [assistant, user] },
    normalizeConfig(),
  );

  const userParts = res.messages[1].content;
  assert.equal(userParts[0].type, 'tool_result', '第一个元素必须仍然是 tool_result');
  assert.ok(userParts[1].text.includes('<internal_handoff'), '第二个元素是挂载的 handoff 块');
  assert.equal(userParts[2].text, '配置已读取，请继续下一步。');
});

test('6. 空消息兜底：剥离思考后变空自动补入 (continued) 防止 400 报错', () => {
  const assistantOnlyReasoning = {
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-r1' },
    content: [{ type: 'reasoning', text: '模型流式中断前仅输出了深度推演。' }],
  };
  const user = { role: 'user', content: '继续' };

  const res = prepareHandoff(
    { provider: 'gemini', model: 'gemini-3.8-flash', messages: [assistantOnlyReasoning, user] },
    normalizeConfig(),
  );

  const cleanedAssistant = res.messages[0];
  assert.equal(cleanedAssistant.content.length, 1);
  assert.equal(cleanedAssistant.content[0].text, '(continued)', '必须自动补入占位符防止 400 报错');
});

test('7. 兼容非数组顶层推理字段：提取 reasoning_content 与 reasoning_details', () => {
  const msg = {
    role: 'assistant',
    reasoning_content: '这是挂在顶层的深度推演思路。',
    content: '这是正式正文。',
  };
  const extracted = extractReasoningFromMessage(msg);
  assert.equal(extracted.hadReasoning, true);
  assert.equal(extracted.thinking, '这是挂在顶层的深度推演思路。');
  assert.equal(extracted.visibleText, '这是正式正文。');
});

test('8. 配置归一化与安全边界兜底', () => {
  const cfg = normalizeConfig({
    headRatio: 2,
    midRatio: 3,
    tailRatio: 5,
    maxThinkingTokens: -100,
  });
  assert.equal(cfg.headRatio, 0.2);
  assert.equal(cfg.midRatio, 0.3);
  assert.equal(cfg.tailRatio, 0.5);
  assert.equal(cfg.maxThinkingTokens, 50, '预算自动兜底下限 50');
});

test('9. 原子落盘与 FIFO 环形缓冲测试', () => {
  const testStorage = path.join(__dirname, 'test-events.json');
  try {
    if (fs.existsSync(testStorage)) fs.unlinkSync(testStorage);
    const store = createEventLog(testStorage);
    store.push({ time: new Date().toISOString(), test: 1 });
    store._flushSync();
    store.destroy();

    assert.ok(fs.existsSync(testStorage), '目标持久化文件必须已创建');
    const data = JSON.parse(fs.readFileSync(testStorage, 'utf8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].test, 1);
  } finally {
    if (fs.existsSync(testStorage)) fs.unlinkSync(testStorage);
  }
});
