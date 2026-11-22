/**
 * dsh-cross-model-bridge - DSH 跨模型思考桥（宿主半）。
 *
 * 背景事实（已在本机 DSH 源码中逐一验证）：
 * - DSH 的规范消息词汇表中，思考内容是 assistant 消息 content 数组里的
 *   { type: 'reasoning', text } 块；原始厂商字段（reasoning_content /
 *   thinkingSignature / 签名）不进入 durable 消息，只保留在 adapter 的
 *   replayState 里按路由校验后回用。
 * - 同模型连续对话时，各适配器用自己的原生 replay（带签名）回传思考，工作正常。
 * - 跨模型时（例如从千问 deepseek 切到 Claude/别的 provider），签名校验必然
 *   失败，适配器降级为"无签名 thinking 块"或直接静默丢弃思考
 *   （pi-ai openai-completions 对无签名思考不发送任何字段）。
 *   结果：新模型完全看不到上一模型的推演过程——这就是本插件要解决的问题。
 *
 * 实现方式（全部走官方公开扩展点，无猴子补丁）：
 * - 监听 Cordis 瀑布事件 'llm/stream'（参考官方 dsh-session-checkpoint-policy
 *   的监听模式）。
 * - Agent 循环构建的请求是 deep-frozen 的，且 next() 不接受参数。因此对
 *   需要改写的请求：克隆整个 options（保留 live 的 signal），把跨模型历史的
 *   reasoning 块转写为正文开头的文本标签并剔除 reasoning 块本身，然后用
 *   ctx.llm.stream(clone) 重新进入瀑布（干净地从外层链走一遍）。
 *   用模块级 WeakSet 标记克隆对象防止无限递归。
 * - 仅当请求里确实存在"跨模型思考"时才克隆重入；否则原样 next() 直通，
 *   零开销。同模型请求（replay 有效）完全不动。
 *
 * 参考致谢：
 * - 'llm/stream' 瀑布监听模式：@deepseek-ai/dsh-session-checkpoint-policy (MIT)
 * - 消息/块词汇表与冻结语义：@deepseek-ai/dsh-llm (MIT) src/index.ts JSDoc
 * - 适配器对跨模型思考的降级行为依据：@deepseek-ai/dsh-llm-deepseek
 *   lib serialize assistant()（无签名时发裸 thinking 块）与
 *   @earendil-works/pi-ai dist/api/openai-completions.js（无签名思考被丢弃）。
 */

export const name = 'dsh-cross-model-bridge';
export const inject = ['llm'];

// ── 配置（可在 cordis.patch.yml insert config 覆盖）────────────────────────
const DEFAULT_CONFIG = {
  enabled: true,
  // 只为最近 N 个"跨模型 assistant 消息"注入思考文本，防 Token 膨胀
  keepThinkingTurns: 1,
  // 单条思考注入的最大字符数，超出截断
  maxThinkingLength: 3000,
  // 注入标签使用的语言
  lang: 'zh',
};

const LABEL = {
  zh: {
    head: (model) => `【前序模型 ${model || '未知模型'} 的推演思路（供接续参考）】`,
    truncated: '……[思考过长已截断]',
  },
  en: {
    head: (model) => `[Previous model ${model || 'unknown'} reasoning (for continuity)]`,
    truncated: '...[reasoning truncated]',
  },
};

// 标记"本插件已处理的克隆请求"，防止重入循环
const HANDLED = new WeakSet();

/** 取出 assistant 消息里所有 reasoning 块文本；无则返回 null。 */
function reasoningTextsOf(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return null;
  const texts = [];
  for (const block of message.content) {
    if (block && block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
      texts.push(block.text.trim());
    }
  }
  return texts.length > 0 ? texts : null;
}

/** assistant 消息 source 里记录的产生路由（provider + model）。 */
function sourceRouteOf(message) {
  const src = message && message.source;
  if (!src || src.kind !== 'model') return undefined;
  return {
    provider: typeof src.provider === 'string' ? src.provider : undefined,
    model: typeof src.model === 'string' ? src.model : undefined,
  };
}

/** 用于标签显示的产生模型名。 */
function sourceModelOf(message) {
  const route = sourceRouteOf(message);
  return route === undefined ? undefined : route.model;
}

/**
 * 判断一条 assistant 消息的思考是否"跨模型/跨路由"。
 *
 * 关键：replay 的有效性由 adapter 实例决定，而 adapter 按 provider 路由注册
 * （LlmRuntime 只在该 adapter 同时拥有历史 provider 与目标 provider 时才暴露
 * replayState）。因此 provider 或 model 任一不同都必须视为跨模型——
 * 只比较 model 会把"同名模型、不同 provider"误判为同模型，导致思考被静默丢弃。
 */
function isCrossModel(message, targetProvider, targetModel) {
  const from = sourceRouteOf(message);
  if (from === undefined) return false; // 拿不到来源就保守地不动
  if (from.provider !== undefined && targetProvider !== undefined && from.provider !== targetProvider) return true;
  return from.model !== targetModel;
}

/**
 * 构建转写后的 assistant content：
 * 保留非 reasoning 块原样（含 tool-call，保证工具契约），把（允许保留的）
 * 跨模型思考以文本标签形式放在最前，剔除 reasoning 块本身。
 */
function bridgeContent(message, targetProvider, targetModel, allowed, config, label) {
  const texts = reasoningTextsOf(message);
  if (texts === null) return null; // 没有思考块，无需改写

  if (!isCrossModel(message, targetProvider, targetModel)) return null; // 同模型/同路由：完全不动，保住原生 replay

  const rest = message.content.filter((b) => !(b && b.type === 'reasoning'));

  if (!allowed) {
    // 跨模型但超出滑动窗口：只剔除 reasoning 块（适配器本来也会丢弃），不注入文本省 Token
    return rest;
  }

  let joined = texts.join('\n\n');
  if (joined.length > config.maxThinkingLength) {
    joined = joined.slice(0, config.maxThinkingLength) + '\n' + label.truncated;
  }
  const tag = `\n${label.head(sourceModelOf(message))}\n${joined}\n\n`;
  return [{ type: 'text', text: tag }, ...rest];
}

/** 深克隆 options，保留 live 的 signal 引用（不 structuredClone 它）。 */
function cloneOptions(options) {
  const { signal, ...rest } = options;
  const clone = structuredClone(rest);
  if (signal !== undefined) clone.signal = signal;
  return clone;
}

/**
 * 主变换：返回改写后的 messages 数组，或 null 表示无需改写。
 * 规则：
 * 1. 只处理 assistant 消息里的 reasoning 块；
 * 2. 同模型历史不动（保住原生 replay 签名路径）；
 * 3. 跨模型思考：最近 keepThinkingTurns 条转写为正文文本标签；
 *   更早的跨模型思考直接剔除（适配器本来也会丢）；
 * 4. 其余角色与块（user/system/tool/文本/图片/tool-call）一律原样保留。
 */
function transformMessages(messages, targetProvider, targetModel, config, label) {
  // 收集"含跨模型思考"的 assistant 消息下标
  const crossIndices = [];
  messages.forEach((m, i) => {
    if (reasoningTextsOf(m) && isCrossModel(m, targetProvider, targetModel)) crossIndices.push(i);
  });
  if (crossIndices.length === 0) return null;

  // 注意：keepThinkingTurns 为 0 时 slice(-0) === slice(0) 会返回全部，
  // 因此必须显式判 0（表示保留 0 条）。负数按 0 处理。
  const raw = Number(config.keepThinkingTurns);
  const keepCount = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 1;
  const allowed = new Set(keepCount === 0 ? [] : crossIndices.slice(-keepCount));

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== 'assistant') return m;
    const next = bridgeContent(m, targetProvider, targetModel, allowed.has(i), config, label);
    if (next === null) return m;
    changed = true;
    return { ...m, content: next };
  });

  return changed ? out : null;
}

export function apply(ctx, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const label = LABEL[config.lang] ?? LABEL.zh;

  ctx.on('llm/stream', (options, next) => {
    if (!config.enabled || !options || !Array.isArray(options.messages)) return next();
    if (HANDLED.has(options)) return next(); // 自己重入的克隆：直通放行

    try {
      const targetProvider = options.provider;
      const targetModel = options.model;
      const nextMessages = transformMessages(options.messages, targetProvider, targetModel, config, label);
      if (nextMessages === null) return next();

      const clone = cloneOptions(options);
      clone.messages = nextMessages;
      HANDLED.add(clone);
      ctx.logger.info(
        `cross-model-bridge: rewrote ${options.messages.length} -> ${nextMessages.length} messages for target ${String(targetProvider)}/${String(targetModel)}`,
      );
      // 重新进入瀑布：从外层链干净地走一遍（含其他监听者与适配器选择）
      return ctx.llm.stream(clone);
    } catch (error) {
      ctx.logger.warn(`cross-model-bridge: transform failed, passing through unchanged: ${String(error)}`);
      return next();
    }
  });
}
