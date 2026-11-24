/**
 * dsh-cross-model-bridge - DSH 跨模型/跨账号思考桥（宿主半）。
 *
 * 核心设计（智能任务接力模式）：
 * 1. 自动检测切换场景：精准识别"同模型换账号"（额度用尽切账号）与"跨模型切换"。
 * 2. 接手模型自感知接力：在出站 Prompt 中注入系统级【任务接棒导航协议】，指导新 AI
 *    主动通读前文历史，继承任务目标、锁定已确认结论、无缝向下推进。
 * 3. 关键推演证据收敛：如前序有深度思考，智能截取末尾收敛阶段的关键推演（限 800 字），
 *    剔除前期无用试错，Token 开销直降 75% 以上；前序未开思考亦能正常接棒。
 * 4. 严格流式生成器契约：使用 async function* 与 return yield*，彻底杜绝 PROVIDER_ERROR。
 * 5. 本地防丢持久化与按会话（Session）数据隔离。
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
  // 只为最近 N 个跨路由 assistant 消息注入接棒协议与思考证据
  keepThinkingTurns: 1,
  // 思考收敛证据的最大字符数（建议 800 字，取最终收敛部分）
  maxThinkingLength: 800,
  lang: 'zh',
};

// 标记"本插件已处理的克隆请求"，防止重入循环
const HANDLED = new WeakSet();

// ── 桥接事件记录器：按 Session 隔离与本地轻量防丢持久化 ──
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

/**
 * 判断一条 assistant 消息是否属于"跨模型或跨账号"。
 * provider 不同（跨账号/平台）或 model 不同（跨模型）均返回 true。
 */
function isCrossModel(message, targetProvider, targetModel) {
  const from = sourceRouteOf(message);
  if (from === undefined) return false;
  if (from.provider !== undefined && targetProvider !== undefined && from.provider !== targetProvider) return true;
  return from.model !== targetModel;
}

/**
 * 生成系统级自感知任务接棒协议 + 关键推演证据
 */
function buildHandoffContent(fromRoute, targetProvider, targetModel, reasoningTexts, maxEvidenceLen) {
  const fromModel = fromRoute ? fromRoute.model : '未知模型';
  const fromProvider = fromRoute ? fromRoute.provider : '未知来源';
  const isSameModel = fromModel === targetModel;

  const banner = isSameModel
    ? `【跨账号任务接棒导航 · 同模型账号切换（${fromModel}）】`
    : `【跨模型任务接棒导航（${fromModel} → ${targetModel}）】`;

  const instructions = [
    banner,
    '系统提示：检测到当前会话已交接给你承接。前序对话包含了完整的项目上下文与历史产出。',
    '请接手模型在处理当前最新输入时，遵循以下接棒规范：',
    '1. 【目标与进度继承】：从前序对话中直接继承当前核心任务目标与工作进度，无需用户重复交代；',
    '2. 【结论与决策锁定】：严格遵守前文已确认的技术选型、设计决定与代码修改方案，勿重新论证已解决的问题；',
    '3. 【无缝推进当前轮】：直接在上一轮的实际产出基础上继续推进下一步，保持代码风格与命名的一致性。',
  ].join('\n');

  // 若有推演思考，收敛提取最接近最终结论的末尾部分，剔除前期漫长试错
  let evidence = '';
  if (reasoningTexts && reasoningTexts.length > 0) {
    let raw = reasoningTexts.join('\n\n');
    const limit = maxEvidenceLen || 800;
    if (raw.length > limit) {
      raw = '……[更早过程性推演已自动收敛省略]\n' + raw.slice(-limit);
    }
    const quoted = raw.split('\n').map((line) => `> ${line}`).join('\n');
    evidence = '\n【前序关键推演收敛证据（供思路连贯参考，勿向用户复述）】：\n' + quoted;
  }

  const injected = instructions + (evidence ? evidence + '\n\n' : '\n\n');
  return {
    injected,
    isSameModel,
    injectedChars: injected.length,
    hasEvidence: Boolean(evidence),
  };
}

/** 把一条跨路由 assistant 消息改写为"无 reasoning 块、前置附带接棒协议与推演证据"。 */
function bridgeContent(message, targetProvider, targetModel, allowed, config) {
  const reasoningTexts = reasoningTextsOf(message);
  const fromRoute = sourceRouteOf(message);
  const cross = isCrossModel(message, targetProvider, targetModel);

  const nonReasoning = (message.content || []).filter(
    (b) => !b || b.type !== 'reasoning',
  );

  if (!cross || !allowed) {
    return {
      content: nonReasoning.length > 0 ? nonReasoning : [{ type: 'text', text: '' }],
      bridged: false,
      stripped: cross && Boolean(reasoningTexts),
      injectedChars: 0,
      isSameModel: false,
      hasEvidence: false,
    };
  }

  const { injected, isSameModel, injectedChars, hasEvidence } = buildHandoffContent(
    fromRoute,
    targetProvider,
    targetModel,
    reasoningTexts,
    config.maxThinkingLength,
  );

  const textBlock = { type: 'text', text: injected };
  return {
    content: [textBlock, ...nonReasoning],
    bridged: true,
    stripped: Boolean(reasoningTexts),
    injectedChars,
    isSameModel,
    hasEvidence,
  };
}

function cloneOptions(options) {
  const clone = { ...options };
  if (options.tools) clone.tools = [...options.tools];
  if (options.stop) clone.stop = [...options.stop];
  if (options.metadata) clone.metadata = { ...options.metadata };
  return clone;
}

function transformMessages(messages, targetProvider, targetModel, config) {
  const candidates = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel)) {
      candidates.push(i);
    }
  }

  const allowedIndices = new Set(candidates.slice(0, config.keepThinkingTurns));

  let injectedMessages = 0;
  let strippedMessages = 0;
  let injectedChars = 0;
  let lastIsSameModel = false;
  let lastHasEvidence = false;
  const sources = new Set();

  const nextMessages = messages.map((m, idx) => {
    if (!m || m.role !== 'assistant') return m;
    const allowed = allowedIndices.has(idx);
    const { content, bridged, stripped, injectedChars: chars, isSameModel, hasEvidence } = bridgeContent(
      m,
      targetProvider,
      targetModel,
      allowed,
      config,
    );
    if (bridged) {
      injectedMessages++;
      injectedChars += chars;
      lastIsSameModel = isSameModel;
      lastHasEvidence = hasEvidence;
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
    stats: {
      injectedMessages,
      strippedMessages,
      injectedChars,
      sources,
      isSameModel: lastIsSameModel,
      hasEvidence: lastHasEvidence,
    },
  };
}

export function apply(ctx, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const events = createEventLog();

  // 严格契约：使用 async function* 与 return yield* 委派，返回规范的 AsyncIterable
  ctx.on('llm/stream', async function* (options, next) {
    if (!config.enabled) return yield* next();
    if (!options || !Array.isArray(options.messages)) return yield* next();
    if (HANDLED.has(options)) return yield* next();

    const targetProvider = options.provider;
    const targetModel = options.model;

    // 智能检测：只要存在前序跨模型或跨账号的 assistant 记录，即启动智能接力
    const isHandoff = options.messages.some(
      (m) => m && m.role === 'assistant' && isCrossModel(m, targetProvider, targetModel),
    );
    if (!isHandoff) return yield* next();

    try {
      const { messages: nextMessages, stats } = transformMessages(
        options.messages,
        targetProvider,
        targetModel,
        config,
      );

      // 记录跨模型/跨账号接力事件
      events.push({
        time: new Date().toISOString(),
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        kind: stats.isSameModel ? 'account' : 'model',
        hasEvidence: stats.hasEvidence,
        target: `${String(targetProvider)} / ${String(targetModel)}`,
        sources: [...stats.sources],
        messages: options.messages.length,
        injectedMessages: stats.injectedMessages,
        strippedMessages: stats.strippedMessages,
        injectedChars: stats.injectedChars,
        tag: stats.isSameModel ? '【跨账号接棒】' : '【跨模型接棒】',
      });

      const clone = cloneOptions(options);
      clone.messages = nextMessages;
      HANDLED.add(clone);
      ctx.logger.info(
        `cross-model-bridge: [${stats.isSameModel ? 'account-handoff' : 'model-handoff'}] rewrote ${options.messages.length} -> ${nextMessages.length} messages for target ${String(targetProvider)}/${String(targetModel)} (session: ${options.sessionId || 'none'})`,
      );
      // 规范流式委派：通过 yield* 委派给下游 AsyncIterable，返回纯粹的可迭代流
      return yield* ctx.llm.stream(clone);
    } catch (error) {
      ctx.logger.warn(`cross-model-bridge: transform failed, passing through unchanged: ${String(error)}`);
      return yield* next();
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
          version: '2.0.0',
          mode: 'smart-handoff',
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
