/**
 * dsh-cross-model-bridge - DSH 跨模型/跨账号智能接力桥（宿主半 v2.1.0 工业级重构版）。
 *
 * 核心设计升级：
 * 1. 结构化预算抽取（首 + 锚点 + 尾）：
 *    - 15% 头部锁定初始目标与约束；
 *    - 25% 中段通过决策信号词正则提取关键决策/排错/权衡句（带正文去重）；
 *    - 60% 尾部保留关键推演收敛证据；
 *    - 具备代码块完整性边界保护（绝不腰斩 ``` / ~~~ 围栏）、语义标点吸附与中英双语加权。
 * 2. Prompt Cache 友好型与防套娃 XML 协议：
 *    - 绝不篡改顶层 system / developer 消息，维持原厂前缀 KV Cache 极高命中率，降低 TTFT；
 *    - 使用标准化 XML 标签 <internal_handoff data-dsh-bridge="1">；
 *    - 多跳切换（A->B->C）自动幂等清洗历史残留旧块；
 *    - 严格保护 Agent Tool Call 紧邻性（绝不在 tool_use 与 tool_result 之间断裂插塞）；
 *    - 剥离纯思考后自动补入 (continued) 兜底，防止 400 空消息报错。
 * 3. 两阶段安全提交（prepareRequest + commitResponse）：
 *    - 遇到 429 限流、网络超时或流式中断时状态不污染，重试依然能无缝接棒。
 * 4. 严格流式生成器契约：使用 async function* 与 return yield*，杜绝 PROVIDER_ERROR。
 * 5. 按 Session 数据隔离与本地磁盘轻量防抖持久化（.bridge-events.json，上限 500 条）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_FILE = path.join(__dirname, '.bridge-events.json');

export const name = 'dsh-cross-model-bridge';
export const inject = ['llm'];

// ── 默认配置 ──────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: true,
  // 思考收敛预算上限（Token 预估，默认 500 Token，约等于 500~800 汉字）
  maxThinkingTokens: 500,
  headRatio: 0.15,
  midRatio: 0.25,
  tailRatio: 0.60,
  asciiWeight: 0.25,
  nonAsciiWeight: 1.0,
  // 只为最近 N 个跨路由 assistant 消息注入接棒协议与思考证据
  keepThinkingTurns: 1,
  lang: 'zh',
};

// 标记"本插件已处理的克隆请求"，防止重入循环
const HANDLED = new WeakSet();

// ── 1. 结构化正则与常量 ────────────────────────────────────────────────────
const DEFAULT_ANCHOR_REGEX = new RegExp(
  [
    '排除|放弃|不能|不要|避免|不可行|根因|报错|失败|冲突|坑|注意|约束|必须|关键|最终|决定|结论|改用|权衡|前提',
    '\\b(?:instead|avoid|cannot|can\'t|won\'t|root cause|error|fail(?:ed)?|conflict|constraint|must|decid(?:e|ed)|conclusion|worth|key)\\b',
  ].join('|'),
  'i',
);

const BRIDGE_HANDOFF_REGEX = /\n*<internal_handoff[^>]*data-dsh-bridge="1"[^>]*>[\s\S]*?<\/internal_handoff>\n*/g;

// ── 2. 中英双语加权 Token 估算 ─────────────────────────────────────────────
function estimateTokens(text, asciiWeight = 0.25, nonAsciiWeight = 1.0) {
  if (!text || typeof text !== 'string') return 0;
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    sum += text.charCodeAt(i) <= 0x7f ? asciiWeight : nonAsciiWeight;
  }
  return Math.ceil(sum);
}

// ── 3. 代码块安全围栏扫描（支持 ``` 与 ~~~） ────────────────────────────────
function getFenceRanges(text) {
  const ranges = [];
  const lineRegex = /^[\t ]*(`{3,}|~{3,})([^\n]*)/gm;
  let open = null;
  let match;
  while ((match = lineRegex.exec(text)) !== null) {
    const marker = match[1];
    const rest = match[2];
    const lineStart = match.index;
    const nextNl = text.indexOf('\n', lineRegex.lastIndex);
    const lineEnd = nextNl === -1 ? text.length : nextNl + 1;

    if (!open) {
      open = { char: marker[0], len: marker.length, start: lineStart };
    } else if (
      marker[0] === open.char &&
      marker.length >= open.len &&
      /^[\t ]*$/.test(rest)
    ) {
      ranges.push({ start: open.start, end: lineEnd });
      open = null;
    }
  }
  if (open) {
    ranges.push({ start: open.start, end: text.length });
  }
  return ranges;
}

// 避免截断 UTF-16 代理对
function avoidSurrogateSplit(text, idx, moveForward = false) {
  if (idx <= 0 || idx >= text.length) return idx;
  const code = text.charCodeAt(idx);
  if (code >= 0xdc00 && code <= 0xdfff) {
    return moveForward ? idx + 1 : idx - 1;
  }
  return idx;
}

// 按 Token 预算寻找切点
function findIndexByBudget(text, budget, fromEnd = false, asciiWeight = 0.25, nonAsciiWeight = 1.0) {
  let acc = 0;
  if (!fromEnd) {
    for (let i = 0; i < text.length; i++) {
      acc += text.charCodeAt(i) <= 0x7f ? asciiWeight : nonAsciiWeight;
      if (acc > budget) return avoidSurrogateSplit(text, i, false);
    }
    return text.length;
  } else {
    for (let i = text.length - 1; i >= 0; i--) {
      acc += text.charCodeAt(i) <= 0x7f ? asciiWeight : nonAsciiWeight;
      if (acc > budget) return avoidSurrogateSplit(text, i + 1, true);
    }
    return 0;
  }
}

// 语义边界吸附（优先段落 -> 换行 -> 句末标点）
function snapHeadEnd(text, rawEnd) {
  const minEnd = Math.floor(rawEnd * 0.65);
  const windowText = text.slice(minEnd, rawEnd);

  const paraIdx = windowText.lastIndexOf('\n\n');
  if (paraIdx !== -1) return minEnd + paraIdx;

  const nlIdx = windowText.lastIndexOf('\n');
  if (nlIdx !== -1) return minEnd + nlIdx;

  const punctMatch = [...windowText.matchAll(/[。！？.!?；;](?=\s|$)/g)];
  if (punctMatch.length > 0) {
    const last = punctMatch[punctMatch.length - 1];
    return minEnd + last.index + last[0].length;
  }
  return rawEnd;
}

function snapTailStart(text, rawStart) {
  const maxStart = rawStart + Math.floor((text.length - rawStart) * 0.35);
  const windowText = text.slice(rawStart, maxStart);

  const paraIdx = windowText.indexOf('\n\n');
  if (paraIdx !== -1) return rawStart + paraIdx + 2;

  const nlIdx = windowText.indexOf('\n');
  if (nlIdx !== -1) return rawStart + nlIdx + 1;

  const punctMatch = windowText.match(/[。！？.!?；;]\s*/);
  if (punctMatch) return rawStart + punctMatch.index + punctMatch[0].length;

  return rawStart;
}

// 修正落在代码块内部的切点
function guardHeadFence(endIdx, fenceRanges) {
  for (const r of fenceRanges) {
    if (r.start < endIdx && endIdx < r.end) {
      return r.start; // 退回到代码块开始之前，丢弃残缺前段
    }
  }
  return endIdx;
}

function guardTailFence(startIdx, fenceRanges) {
  for (const r of fenceRanges) {
    if (r.start < startIdx && startIdx < r.end) {
      return r.end; // 前进到代码块结束之后，丢弃残缺后段
    }
  }
  return startIdx;
}

// ── 4. 中段决策锚点抽取（跳过代码块并做正文去重） ─────────────────────────
function extractMiddleAnchors(text, startIdx, endIdx, fenceRanges, options) {
  const {
    midBudget,
    anchorRegex = DEFAULT_ANCHOR_REGEX,
    assistantText = '',
    asciiWeight = 0.25,
    nonAsciiWeight = 1.0,
  } = options;

  if (endIdx <= startIdx || midBudget <= 0) {
    return { text: '', usedTokens: 0, lastEnd: startIdx, count: 0 };
  }

  // 剔除中段内的代码块区间，只扫描自然语言思考
  const proseSpans = [];
  let cursor = startIdx;
  for (const r of fenceRanges) {
    if (r.end <= startIdx) continue;
    if (r.start >= endIdx) break;
    if (r.start > cursor) proseSpans.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < endIdx) proseSpans.push({ start: cursor, end: endIdx });

  const normalizedReply = assistantText ? assistantText.replace(/\s+/g, '') : '';
  const candidates = [];
  const seen = new Set();
  const sentenceRegex = /[^。\n！？；;]+(?:[。！？；;]+|\n|$)/g;

  for (const span of proseSpans) {
    const chunk = text.slice(span.start, span.end);
    sentenceRegex.lastIndex = 0;
    let m;
    while ((m = sentenceRegex.exec(chunk)) !== null) {
      if (m[0].length === 0) {
        sentenceRegex.lastIndex++;
        continue;
      }
      const sentence = m[0].trim();
      if (sentence.length < 8) continue;
      if (!anchorRegex.test(sentence)) continue;

      const norm = sentence.replace(/\s+/g, '');
      if (seen.has(norm)) continue;
      if (normalizedReply && norm.length >= 16 && normalizedReply.includes(norm)) {
        continue; // 正文已完整说明的句子不重复占用宝贵的思考预算
      }

      seen.add(norm);
      candidates.push({
        text: sentence,
        tokens: estimateTokens(sentence, asciiWeight, nonAsciiWeight),
        endOffset: span.start + m.index + m[0].length,
      });
    }
  }

  // 倒序优先保留越靠近结论的决策锚点，再恢复时间顺序
  const picked = [];
  let usedTokens = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i];
    if (usedTokens + item.tokens > midBudget) continue;
    picked.push(item);
    usedTokens += item.tokens;
  }

  if (picked.length === 0) {
    return { text: '', usedTokens: 0, lastEnd: startIdx, count: 0 };
  }

  picked.reverse();
  return {
    text: picked.map((p) => `- ${p.text}`).join('\n'),
    usedTokens,
    lastEnd: picked[picked.length - 1].endOffset,
    count: picked.length,
  };
}

// ── 5. 三段式思考链智能抽取引擎 ───────────────────────────────────────────
function extractThinkingSummary(thinking, opts = {}) {
  if (typeof thinking !== 'string') return { summary: '', stats: null };
  const text = thinking.replace(/\r\n/g, '\n').trim();
  if (!text) return { summary: '', stats: null };

  const maxTokens = opts.maxThinkingTokens || DEFAULT_CONFIG.maxThinkingTokens;
  const headRatio = opts.headRatio ?? DEFAULT_CONFIG.headRatio;
  const midRatio = opts.midRatio ?? DEFAULT_CONFIG.midRatio;
  const asciiWeight = opts.asciiWeight ?? DEFAULT_CONFIG.asciiWeight;
  const nonAsciiWeight = opts.nonAsciiWeight ?? DEFAULT_CONFIG.nonAsciiWeight;

  const totalTokens = estimateTokens(text, asciiWeight, nonAsciiWeight);
  if (totalTokens <= maxTokens) {
    return {
      summary: text,
      stats: {
        totalTokens,
        isTruncated: false,
        headChars: text.length,
        anchorCount: 0,
        tailChars: 0,
      },
    };
  }

  const fenceRanges = getFenceRanges(text);
  const headBudget = Math.floor(maxTokens * headRatio);
  const midBudget = Math.floor(maxTokens * midRatio);
  const baseTailBudget = Math.max(1, maxTokens - headBudget - midBudget);

  // 1. 抽取头部（锁定初始目标）
  let headEnd = findIndexByBudget(text, headBudget, false, asciiWeight, nonAsciiWeight);
  headEnd = snapHeadEnd(text, headEnd);
  headEnd = guardHeadFence(headEnd, fenceRanges);
  const headText = text.slice(0, headEnd).trim();

  // 2. 预估尾部起点
  const tentativeTailStart = Math.max(
    headEnd,
    findIndexByBudget(text, baseTailBudget, true, asciiWeight, nonAsciiWeight),
  );

  // 3. 抽取中段锚点
  const mid = extractMiddleAnchors(text, headEnd, tentativeTailStart, fenceRanges, {
    midBudget,
    anchorRegex: DEFAULT_ANCHOR_REGEX,
    assistantText: opts.assistantText || '',
    asciiWeight,
    nonAsciiWeight,
  });

  // 4. 动态预算回流：中段未用完的预算全额补给尾部
  const leftoverBudget = Math.max(0, midBudget - mid.usedTokens);
  const finalTailBudget = baseTailBudget + leftoverBudget;
  const minTailStart = Math.max(headEnd, mid.lastEnd);

  let tailStart = findIndexByBudget(text, finalTailBudget, true, asciiWeight, nonAsciiWeight);
  tailStart = Math.max(minTailStart, tailStart);
  tailStart = snapTailStart(text, tailStart);
  tailStart = guardTailFence(tailStart, fenceRanges);

  let tailText = text.slice(tailStart).trim();

  // 兜底：若尾部恰好落在超长代码块里导致被清空，抢救紧邻代码块前方的说明
  if ((!tailText || tailText.length === 0) && tailStart >= text.length) {
    const lastFence = fenceRanges[fenceRanges.length - 1];
    if (lastFence && lastFence.start > minTailStart) {
      const beforeFence = text.slice(minTailStart, lastFence.start);
      let fallbackStart = findIndexByBudget(beforeFence, finalTailBudget, true, asciiWeight, nonAsciiWeight);
      fallbackStart = snapTailStart(beforeFence, fallbackStart);
      tailText = beforeFence.slice(fallbackStart).trim();
    }
  }

  // 5. 组装结果
  const sections = [];
  if (headText) sections.push(headText);
  if (mid.text) sections.push(`【关键决策与排错项】\n${mid.text}`);
  if (tailText) sections.push(tailText);

  const summary = sections.join('\n\n');
  return {
    summary,
    stats: {
      totalTokens: estimateTokens(summary, asciiWeight, nonAsciiWeight),
      isTruncated: true,
      headChars: headText.length,
      anchorCount: mid.count,
      tailChars: tailText.length,
    },
  };
}

// ── 6. 防套娃清洗与 XML 结构化协议构建 ────────────────────────────────────
function stripHandoffFromText(text) {
  if (typeof text !== 'string' || !text.includes('data-dsh-bridge="1"')) {
    return text;
  }
  return text.replace(BRIDGE_HANDOFF_REGEX, (match, offset, fullStr) => {
    const atStart = offset === 0;
    const atEnd = offset + match.length === fullStr.length;
    return atStart || atEnd ? '' : '\n\n';
  });
}

function buildHandoffBlock(summary, meta = {}) {
  const safeAttr = (v) => String(v ?? '').replace(/["<>&]/g, '');
  const safeBody = String(summary)
    .trim()
    .replace(/<\/internal_handoff>/gi, '&lt;/internal_handoff&gt;');

  const attrs = ['data-dsh-bridge="1"'];
  if (meta.fromModel) attrs.push(`from="${safeAttr(meta.fromModel)}"`);
  if (meta.mode) attrs.push(`mode="${safeAttr(meta.mode)}"`);

  const banner = meta.mode === 'cross-account'
    ? `[跨账号接棒导航 · 同模型账号切换（${meta.fromModel || '同架构'}）]`
    : `[跨模型接棒导航（${meta.fromModel || '前序模型'} → ${meta.targetModel || '接手模型'}）]`;

  return [
    `<internal_handoff ${attrs.join(' ')}>`,
    banner,
    '系统提示：当前会话已交接给你承接。请直接继承前文所有技术决定与既有进度，保持风格一致，切勿向用户复述本段标记。',
    '',
    safeBody,
    '',
    'Use this as your prior working memory and respond directly to the user.',
    '</internal_handoff>',
  ].join('\n');
}

// ── 7. 辅助识别与深拷贝 ───────────────────────────────────────────────────
function sourceRouteOf(message) {
  const src = message && message.source;
  if (!src || src.kind !== 'model') return undefined;
  return {
    provider: typeof src.provider === 'string' ? src.provider : undefined,
    model: typeof src.model === 'string' ? src.model : undefined,
  };
}

function isCrossModel(message, targetProvider, targetModel) {
  const from = sourceRouteOf(message);
  if (from === undefined) return false;
  if (from.provider !== undefined && targetProvider !== undefined && from.provider !== targetProvider) return true;
  return from.model !== targetModel;
}

function cloneOptions(options) {
  const clone = { ...options };
  if (options.tools) clone.tools = [...options.tools];
  if (options.stop) clone.stop = [...options.stop];
  if (options.metadata) clone.metadata = { ...options.metadata };
  return clone;
}

// ── 8. 事件记录器与本地防抖持久化 ─────────────────────────────────────────
const MAX_EVENTS = 500;

function createEventLog() {
  let events = [];
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
      if (Array.isArray(data)) {
        events = data.slice(-MAX_EVENTS);
      }
    }
  } catch (err) {
    // 忽略损坏的持久化文件
  }

  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(events, null, 2), 'utf8');
      } catch (err) {
        // 忽略写入失败
      }
    }, 500);
  }

  return {
    push(event) {
      events.push(event);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      persist();
    },
    list() { return [...events]; },
    get size() { return events.length; },
  };
}

// ── 9. 出站消息改写与 Prompt Cache 友好注入 ───────────────────────────────
function prepareHandoff(options, config) {
  const targetProvider = options.provider;
  const targetModel = options.model;
  const messages = options.messages || [];

  // 1. 寻找最近的跨路由 assistant 消息
  let lastCrossAssistantIdx = -1;
  let lastAssistantMsg = null;
  let fromRoute = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel)) {
      lastCrossAssistantIdx = i;
      lastAssistantMsg = m;
      fromRoute = sourceRouteOf(m);
      break;
    }
  }

  if (lastCrossAssistantIdx === -1 || !lastAssistantMsg) {
    return { shouldHandoff: false, messages };
  }

  const isSameModel = fromRoute?.model === targetModel;
  const mode = isSameModel ? 'cross-account' : 'cross-model';

  // 2. 提取前序思考文本与正文（用于去重）
  let rawThinking = '';
  let assistantVisibleText = '';
  if (Array.isArray(lastAssistantMsg.content)) {
    for (const b of lastAssistantMsg.content) {
      if (!b) continue;
      if (b.type === 'reasoning' && typeof b.text === 'string') {
        rawThinking += (rawThinking ? '\n\n' : '') + b.text;
      } else if (b.type === 'text' && typeof b.text === 'string') {
        assistantVisibleText += b.text;
      }
    }
  } else if (typeof lastAssistantMsg.content === 'string') {
    assistantVisibleText = lastAssistantMsg.content;
  }

  // 3. 执行三段式智能抽取（首部 15% + 决策锚点 25% + 尾部 60%）
  const { summary, stats: extractionStats } = extractThinkingSummary(rawThinking, {
    maxThinkingTokens: config.maxThinkingTokens,
    headRatio: config.headRatio,
    midRatio: config.midRatio,
    tailRatio: config.tailRatio,
    asciiWeight: config.asciiWeight,
    nonAsciiWeight: config.nonAsciiWeight,
    assistantText: assistantVisibleText,
  });

  // 4. 构建结构化 XML handoff 块
  const handoffBlock = buildHandoffBlock(
    summary || '（前序无深度推演块，直接继承完整历史对话上下文）',
    {
      fromModel: fromRoute?.model,
      targetModel,
      mode,
    },
  );

  // 5. 遍历并变换消息列表：
  //    - 严禁篡改顶层 system / developer 消息（保住 Prompt Cache！）
  //    - 清洗历史消息残留的旧 <internal_handoff>（防套娃）
  //    - 剥离跨模型 assistant 消息的 reasoning 块与签名，空消息补 (continued)
  //    - 找到最新的有效 user 消息，将 handoffBlock 注入（避开破坏 Tool Call 紧邻性）
  let targetUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      targetUserIdx = i;
      break;
    }
  }

  let strippedCount = 0;
  const nextMessages = messages.map((m, idx) => {
    if (!m) return m;

    // 保留系统消息，绝不修改
    if (m.role === 'system' || m.role === 'developer') {
      return m;
    }

    // 处理 assistant 消息
    if (m.role === 'assistant') {
      const copy = { ...m };
      if ('thinkingSignature' in copy) delete copy.thinkingSignature;
      if ('reasoning_content' in copy) delete copy.reasoning_content;

      if (Array.isArray(copy.content)) {
        // 过滤 reasoning 块并清洗旧 handoff
        const cleaned = [];
        let hadReasoning = false;
        for (const b of copy.content) {
          if (!b) continue;
          if (b.type === 'reasoning') {
            hadReasoning = true;
            continue;
          }
          if (b.type === 'text' && typeof b.text === 'string') {
            const strippedText = stripHandoffFromText(b.text);
            if (strippedText) cleaned.push({ ...b, text: strippedText });
          } else {
            cleaned.push(b);
          }
        }
        if (hadReasoning) strippedCount++;
        // 空消息兜底：防止剥离思考后变为空消息触发 400
        if (cleaned.length === 0 && (!copy.tool_calls || copy.tool_calls.length === 0)) {
          cleaned.push({ type: 'text', text: '(continued)' });
        }
        copy.content = cleaned;
      } else if (typeof copy.content === 'string') {
        copy.content = stripHandoffFromText(copy.content) || '(continued)';
      }
      return copy;
    }

    // 处理目标 user 消息：挂载 handoff 块
    if (idx === targetUserIdx && m.role === 'user') {
      const copy = { ...m };
      if (typeof copy.content === 'string') {
        const cleaned = stripHandoffFromText(copy.content);
        copy.content = handoffBlock + '\n\n' + cleaned;
      } else if (Array.isArray(copy.content)) {
        // 检查是否包含 tool_result / functionResponse
        let lastToolResultIdx = -1;
        for (let j = 0; j < copy.content.length; j++) {
          const item = copy.content[j];
          if (item && (item.type === 'tool_result' || item.functionResponse)) {
            lastToolResultIdx = j;
          }
        }
        const cleanedContent = copy.content.map((b) => {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            return { ...b, text: stripHandoffFromText(b.text) };
          }
          return b;
        });

        const handoffNode = { type: 'text', text: handoffBlock };
        if (lastToolResultIdx !== -1) {
          // 紧随最后一个 tool_result 之后插入，绝不破坏前置工具链
          cleanedContent.splice(lastToolResultIdx + 1, 0, handoffNode);
        } else {
          // 普通 user 消息，前置插入
          cleanedContent.unshift(handoffNode);
        }
        copy.content = cleanedContent;
      }
      return copy;
    }

    // 其他消息：仅清洗可能残留的旧 handoff
    if (typeof m.content === 'string') {
      return { ...m, content: stripHandoffFromText(m.content) };
    }
    return m;
  });

  return {
    shouldHandoff: true,
    messages: nextMessages,
    stats: {
      mode,
      isSameModel,
      fromModel: fromRoute?.model || '未知',
      fromProvider: fromRoute?.provider || '未知',
      targetModel,
      targetProvider,
      strippedCount,
      hasEvidence: Boolean(rawThinking),
      extractionStats,
      injectedChars: handoffBlock.length,
      estimatedTokens: estimateTokens(handoffBlock, config.asciiWeight, config.nonAsciiWeight),
    },
  };
}

// ── 10. Cordis 插件入口 ───────────────────────────────────────────────────
export function apply(ctx, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const events = createEventLog();

  // 严格契约：使用 async function* 异步生成器，确保下游消费到合法的 AsyncIterable
  ctx.on('llm/stream', async function* (options, next) {
    if (!config.enabled) return yield* next();
    if (!options || !Array.isArray(options.messages)) return yield* next();
    if (HANDLED.has(options)) return yield* next();

    const targetProvider = options.provider;
    const targetModel = options.model;
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;

    // 检查是否存在前序跨路由 assistant 消息
    const isHandoff = options.messages.some(
      (m) => m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel),
    );
    if (!isHandoff) return yield* next();

    // 阶段一（prepareRequest）：出站计算与消息改写，不立即更新路由状态（防止 429 重试失效）
    const prepared = prepareHandoff(options, config);
    if (!prepared.shouldHandoff) return yield* next();

    const clone = cloneOptions(options);
    clone.messages = prepared.messages;
    HANDLED.add(clone);

    ctx.logger.info(
      `cross-model-bridge: [${prepared.stats.mode}] injecting handoff (${prepared.stats.fromModel} -> ${targetModel}) with ${prepared.stats.estimatedTokens} tokens for session ${sessionId || 'none'}`,
    );

    let stream;
    try {
      stream = ctx.llm.stream(clone);
    } catch (err) {
      ctx.logger.warn(`cross-model-bridge: stream initialization failed: ${String(err)}`);
      return yield* next();
    }

    // 阶段二（commitResponse）：在流式安全返回并被消费时才提交事件，防污染
    let streamFailed = false;
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
    } catch (streamErr) {
      streamFailed = true;
      ctx.logger.warn(`cross-model-bridge: stream transmission error: ${String(streamErr)}`);
      throw streamErr;
    } finally {
      if (!streamFailed) {
        events.push({
          time: new Date().toISOString(),
          sessionId,
          kind: prepared.stats.isSameModel ? 'account' : 'model',
          mode: prepared.stats.mode,
          hasEvidence: prepared.stats.hasEvidence,
          target: `${String(targetProvider)} / ${String(targetModel)}`,
          sources: [`${prepared.stats.fromProvider} / ${prepared.stats.fromModel}`],
          messages: options.messages.length,
          strippedMessages: prepared.stats.strippedCount,
          injectedChars: prepared.stats.injectedChars,
          estimatedTokens: prepared.stats.estimatedTokens,
          extraction: prepared.stats.extractionStats,
          tag: prepared.stats.isSameModel ? '【跨账号接棒】' : '【跨模型接棒】',
        });
      }
    }
  });

  // ── 页面数据通道：GET /plugins/dsh-cross-model-bridge/events ──
  ctx.inject(['webServer'], (sub) => {
    const ws = sub.get('webServer');
    if (!ws) return;
    const send = (res, code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    const dispose = ws.register({
      kind: 'exact',
      path: '/plugins/dsh-cross-model-bridge/events',
      handler: async (req, res) => {
        const method = req.method || 'GET';
        if (method !== 'GET') return send(res, 405, { error: 'GET only' });

        let reqSessionId = null;
        try {
          const url = new URL(req.url, 'http://localhost');
          reqSessionId = url.searchParams.get('sessionId');
        } catch (e) {}

        const allList = events.list();
        const filteredList = reqSessionId
          ? allList.filter((e) => e.sessionId === reqSessionId)
          : allList;

        return send(res, 200, {
          enabled: config.enabled === true,
          version: '2.1.0',
          mode: 'smart-handoff-v2',
          maxThinkingTokens: config.maxThinkingTokens,
          lang: config.lang,
          events: filteredList,
          totalEvents: allList.length,
          sessionId: reqSessionId,
        });
      },
    });
    return () => {
      try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ }
    };
  });
}

// 导出纯算法函数供单测与外部调用
export {
  estimateTokens,
  getFenceRanges,
  extractThinkingSummary,
  stripHandoffFromText,
  buildHandoffBlock,
  prepareHandoff,
};

