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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_FILE = path.join(__dirname, '.bridge-events.json');

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
    note: '（以下为系统注入的历史上下文，仅供接续参考；请在回答中直接使用其结论，不要复述本标签或本段格式。）',
    truncated: '……[思考过长已截断]',
  },
  en: {
    head: (model) => `[Previous model ${model || 'unknown'} reasoning (for continuity)]`,
    note: '(System-injected historical context for reference only; use its conclusions directly and do not repeat this label or its format in your reply.)',
    truncated: '...[reasoning truncated]',
  },
};

// 标记"本插件已处理的克隆请求"，防止重入循环
const HANDLED = new WeakSet();

// ── 桥接事件记录器：支持按 Session 隔离与本地轻量防丢持久化 ──
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
 */
function isCrossModel(message, targetProvider, targetModel) {
  const from = sourceRouteOf(message);
  if (from === undefined) return false;
  if (from.provider !== undefined && targetProvider !== undefined && from.provider !== targetProvider) return true;
  return from.model !== targetModel;
}

/** 把一条 assistant 消息改写为"无 reasoning 块、正文前附带思考文本标签"。 */
function bridgeContent(message, targetProvider, targetModel, allowed, config, label) {
  const reasoningTexts = reasoningTextsOf(message);
  const cross = isCrossModel(message, targetProvider, targetModel);

  const nonReasoning = (message.content || []).filter(
    (b) => !b || b.type !== 'reasoning',
  );

  if (!cross || !reasoningTexts || !allowed) {
    return {
      content: nonReasoning.length > 0 ? nonReasoning : [{ type: 'text', text: '' }],
      bridged: false,
      stripped: cross && Boolean(reasoningTexts),
      injectedChars: 0,
    };
  }

  const modelName = sourceModelOf(message);
  let raw = reasoningTexts.join('\n\n');
  let truncated = false;
  if (raw.length > config.maxThinkingLength) {
    raw = raw.slice(0, config.maxThinkingLength);
    truncated = true;
  }

  const quoted = raw
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  const injected = [
    label.head(modelName),
    quoted,
    ...(truncated ? [`> ${label.truncated}`] : []),
    label.note,
    '',
  ].join('\n');

  const textBlock = { type: 'text', text: injected };
  return {
    content: [textBlock, ...nonReasoning],
    bridged: true,
    stripped: false,
    injectedChars: injected.length,
  };
}

function cloneOptions(options) {
  const clone = { ...options };
  if (options.tools) clone.tools = [...options.tools];
  if (options.stop) clone.stop = [...options.stop];
  if (options.metadata) clone.metadata = { ...options.metadata };
  return clone;
}

function transformMessages(messages, targetProvider, targetModel, config, label) {
  const candidates = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel) && reasoningTextsOf(m)) {
      candidates.push(i);
    }
  }

  const allowedIndices = new Set(candidates.slice(0, config.keepThinkingTurns));

  let injectedMessages = 0;
  let strippedMessages = 0;
  let injectedChars = 0;
  const sources = new Set();

  const nextMessages = messages.map((m, idx) => {
    if (!m || m.role !== 'assistant') return m;
    const allowed = allowedIndices.has(idx);
    const { content, bridged, stripped, injectedChars: chars } = bridgeContent(
      m,
      targetProvider,
      targetModel,
      allowed,
      config,
      label,
    );
    if (bridged) {
      injectedMessages++;
      injectedChars += chars;
      const r = sourceRouteOf(m);
      if (r) sources.add(`${r.provider || '?'} / ${r.model || '?'}`);
    }
    if (stripped) strippedMessages++;

    const copy = { ...m, content };
    if ('thinkingSignature' in copy) delete copy.thinkingSignature;
    return copy;
  });

  return {
    messages: nextMessages,
    stats: { injectedMessages, strippedMessages, injectedChars, sources },
  };
}

export function apply(ctx, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const label = LABEL[config.lang] || LABEL.zh;
  const events = createEventLog();

  ctx.on('llm/stream', (options, next) => {
    if (!config.enabled) return next();
    if (!options || !Array.isArray(options.messages)) return next();
    if (HANDLED.has(options)) return next();

    const targetProvider = options.provider;
    const targetModel = options.model;

    const hasCrossReasoning = options.messages.some(
      (m) => m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel) && reasoningTextsOf(m),
    );
    if (!hasCrossReasoning) return next();

    try {
      const { messages: nextMessages, stats } = transformMessages(
        options.messages,
        targetProvider,
        targetModel,
        config,
        label,
      );

      // 记录桥接事件（含会话 sessionId，支持按对话隔离）
      events.push({
        time: new Date().toISOString(),
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        target: `${String(targetProvider)} / ${String(targetModel)}`,
        sources: [...stats.sources],
        messages: options.messages.length,
        injectedMessages: stats.injectedMessages,
        strippedMessages: stats.strippedMessages,
        injectedChars: stats.injectedChars,
        tag: label.head([...stats.sources][0]?.split(' / ').pop()),
      });

      const clone = cloneOptions(options);
      clone.messages = nextMessages;
      HANDLED.add(clone);
      ctx.logger.info(
        `cross-model-bridge: rewrote ${options.messages.length} -> ${nextMessages.length} messages for target ${String(targetProvider)}/${String(targetModel)} (session: ${options.sessionId || 'none'})`,
      );
      return ctx.llm.stream(clone);
    } catch (error) {
      ctx.logger.warn(`cross-model-bridge: transform failed, passing through unchanged: ${String(error)}`);
      return next();
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
          version: '1.2.0',
          keepThinkingTurns: config.keepThinkingTurns,
          maxThinkingLength: config.maxThinkingLength,
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
