/**
 * dsh-cross-model-bridge - DSH 跨模型/跨账号智能接力桥（Cordis 宿主入口 v2.1.0）。
 *
 * 模块职责：
 * 1. 组装 lib/ 子模块（config、extractor、protocol、store）；
 * 2. 监听 Cordis 'llm/stream' 瀑布流事件，严格遵循 async function* 异步生成器流式契约；
 * 3. 注册 /plugins/dsh-cross-model-bridge/events 数据查询接口。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from './lib/config.js';
import { prepareHandoff, isCrossModel } from './lib/protocol.js';
import { createEventLog } from './lib/store.js';

// 导出纯算法函数与工具，供单测与外部插件调用
export * from './lib/config.js';
export * from './lib/extractor.js';
export * from './lib/protocol.js';
export * from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_FILE = path.join(__dirname, '.bridge-events.json');

export const name = 'dsh-cross-model-bridge';
export const inject = ['llm'];

// 标记"本插件已处理的克隆请求"，防止重入循环
const HANDLED = new WeakSet();

function cloneOptions(options) {
  const clone = { ...options };
  if (options.tools) clone.tools = [...options.tools];
  if (options.stop) clone.stop = [...options.stop];
  if (options.metadata) clone.metadata = { ...options.metadata };
  return clone;
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} [userConfig] 插件配置
 * @param {{ storageFile?: string }} [deps] 仅供测试 / 嵌入场景覆盖事件持久化路径
 */
export function apply(ctx, userConfig = {}, { storageFile = STORAGE_FILE } = {}) {
  const config = normalizeConfig(userConfig);
  const events = createEventLog(storageFile);

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

    if (prepared.injected) {
      ctx.logger.info(
        `cross-model-bridge: [${prepared.stats.mode}] injecting handoff (${prepared.stats.fromModel} -> ${targetModel}) with ${prepared.stats.estimatedTokens} tokens for session ${sessionId || 'none'}`,
      );
    }

    let stream;
    try {
      stream = ctx.llm.stream(clone);
    } catch (err) {
      ctx.logger.warn(`cross-model-bridge: stream initialization failed: ${String(err)}`);
      return yield* next();
    }

    // 阶段二（commitResponse）：仅在流完整结束后才提交事件，防状态污染。
    // 调用方中途 return()（如用户点"停止"）不会进入 catch，所以不能靠"没报错"判断，必须显式标记完成。
    let completed = false;
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
      completed = true;
    } catch (streamErr) {
      ctx.logger.warn(`cross-model-bridge: stream transmission error: ${String(streamErr)}`);
      throw streamErr;
    } finally {
      if (completed && prepared.injected) {
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
