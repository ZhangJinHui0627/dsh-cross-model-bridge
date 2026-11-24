/**
 * dsh-cross-model-bridge - XML 接力协议构建、防套娃清洗与非数组推理字段兼容模块。
 */

import { extractThinkingSummary, estimateTokens } from './extractor.js';

export const BRIDGE_HANDOFF_REGEX = /\n*<internal_handoff[^>]*data-dsh-bridge="1"[^>]*>[\s\S]*?<\/internal_handoff>\n*/g;

/** 幂等清洗历史消息中可能残留的旧 handoff 块（杜绝 A->B->C 多跳无限嵌套） */
export function stripHandoffFromText(text) {
  if (typeof text !== 'string' || !text.includes('data-dsh-bridge="1"')) {
    return text;
  }
  return text.replace(BRIDGE_HANDOFF_REGEX, (match, offset, fullStr) => {
    const atStart = offset === 0;
    const atEnd = offset + match.length === fullStr.length;
    return atStart || atEnd ? '' : '\n\n';
  });
}

/** 构建标准化 XML 结构化接力协议块 */
export function buildHandoffBlock(summary, meta = {}) {
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

/**
 * 从消息中全面提取思考文本与正文：
 * 兼容数组结构（type === 'reasoning' | 'thinking'）与非数组结构（顶层 reasoning_content / reasoning_details）
 */
export function extractReasoningFromMessage(message) {
  if (!message || message.role !== 'assistant') {
    return { thinking: '', visibleText: '', hadReasoning: false };
  }

  const thinkingParts = [];
  const textParts = [];
  let hadReasoning = false;

  // 1. 兼容顶层 reasoning_content（DeepSeek 原生 / 部分中转站格式）
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    thinkingParts.push(message.reasoning_content.trim());
    hadReasoning = true;
  }

  // 2. 兼容顶层 reasoning_details
  if (typeof message.reasoning_details === 'string' && message.reasoning_details.trim()) {
    thinkingParts.push(message.reasoning_details.trim());
    hadReasoning = true;
  } else if (Array.isArray(message.reasoning_details)) {
    for (const d of message.reasoning_details) {
      if (typeof d?.text === 'string' && d.text.trim()) {
        thinkingParts.push(d.text.trim());
        hadReasoning = true;
      }
    }
  }

  // 3. 扫描 content（支持数组与字符串）
  if (Array.isArray(message.content)) {
    for (const b of message.content) {
      if (!b) continue;
      // 兼容 reasoning 与 thinking 类型块
      if ((b.type === 'reasoning' || b.type === 'thinking') && typeof b.text === 'string' && b.text.trim()) {
        thinkingParts.push(b.text.trim());
        hadReasoning = true;
      } else if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }
  } else if (typeof message.content === 'string') {
    textParts.push(message.content);
  }

  return {
    thinking: thinkingParts.join('\n\n'),
    visibleText: textParts.join('\n\n'),
    hadReasoning,
  };
}

export function sourceRouteOf(message) {
  const src = message && message.source;
  if (!src || src.kind !== 'model') return undefined;
  return {
    provider: typeof src.provider === 'string' ? src.provider : undefined,
    model: typeof src.model === 'string' ? src.model : undefined,
  };
}

export function isCrossModel(message, targetProvider, targetModel) {
  const from = sourceRouteOf(message);
  if (from === undefined) return false;
  if (from.provider !== undefined && targetProvider !== undefined && from.provider !== targetProvider) return true;
  return from.model !== targetModel;
}

/**
 * 出站消息分析、三段式提取与安全改写（prepareRequest 核心）
 */
export function prepareHandoff(options, config) {
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

  // 2. 提取前序思考文本与正文（兼容非数组顶层字段与 content 数组）
  const { thinking: rawThinking, visibleText: assistantVisibleText } = extractReasoningFromMessage(lastAssistantMsg);

  // 3. 执行三段式智能抽取（首部 + 决策锚点 + 尾部）
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

  // 5. 寻找最新的有效 user 消息
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

    // 严禁篡改顶层 system / developer 消息（100% 保住 Prompt Cache 前缀命中）
    if (m.role === 'system' || m.role === 'developer') {
      return m;
    }

    // 处理 assistant 消息：剥离跨模型/跨账号的思考字段，防套娃清洗与 (continued) 兜底
    if (m.role === 'assistant') {
      const copy = { ...m };
      if ('thinkingSignature' in copy) delete copy.thinkingSignature;
      if ('reasoning_content' in copy) delete copy.reasoning_content;
      if ('reasoning_details' in copy) delete copy.reasoning_details;

      if (Array.isArray(copy.content)) {
        const cleaned = [];
        let hadReasoning = false;
        for (const b of copy.content) {
          if (!b) continue;
          if (b.type === 'reasoning' || b.type === 'thinking') {
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
        // 空消息兜底：防止剥离思考后变为空消息触发 400 校验报错
        if (cleaned.length === 0 && (!copy.tool_calls || copy.tool_calls.length === 0)) {
          cleaned.push({ type: 'text', text: '(continued)' });
        }
        copy.content = cleaned;
      } else if (typeof copy.content === 'string') {
        copy.content = stripHandoffFromText(copy.content) || '(continued)';
      }
      return copy;
    }

    // 处理目标 user 消息：挂载 handoff 块（保护 Agent 工具链紧邻性）
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
          // 紧随最后一个 tool_result 之后插入，绝不破坏 tool_use 与 tool_result 的配对紧邻性
          cleanedContent.splice(lastToolResultIdx + 1, 0, handoffNode);
        } else {
          // 普通 user 消息，前置插入
          cleanedContent.unshift(handoffNode);
        }
        copy.content = cleanedContent;
      }
      return copy;
    }

    // 其他消息：仅清洗可能残留的旧 handoff 标记
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
