/**
 * dsh-cross-model-bridge - 配置管理与参数校验归一化模块。
 */

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxThinkingTokens: 500,
  headRatio: 0.15,
  midRatio: 0.25,
  tailRatio: 0.60,
  asciiWeight: 0.25,
  nonAsciiWeight: 1.0,
  keepThinkingTurns: 1,
  lang: 'zh',
});

/**
 * 校验并自动归一化用户配置：
 * 1. 预算与轮次下限兜底；
 * 2. 比例自动归一化（headRatio + midRatio + tailRatio === 1.0）。
 */
export function normalizeConfig(userConfig = {}) {
  const merged = { ...DEFAULT_CONFIG, ...userConfig };

  // 1. 预算与轮次下限校验
  let maxThinkingTokens = Number(merged.maxThinkingTokens);
  if (!Number.isFinite(maxThinkingTokens) || maxThinkingTokens < 50) {
    maxThinkingTokens = 50; // 最低安全预算，防止截断逻辑越界
  }

  let keepThinkingTurns = Math.floor(Number(merged.keepThinkingTurns));
  if (!Number.isFinite(keepThinkingTurns) || keepThinkingTurns < 0) {
    keepThinkingTurns = 0;
  }

  // 2. 权重校验
  let asciiWeight = Number(merged.asciiWeight);
  if (!Number.isFinite(asciiWeight) || asciiWeight <= 0) asciiWeight = 0.25;

  let nonAsciiWeight = Number(merged.nonAsciiWeight);
  if (!Number.isFinite(nonAsciiWeight) || nonAsciiWeight <= 0) nonAsciiWeight = 1.0;

  // 3. 三段式比例归一化
  let head = Math.max(0, Number(merged.headRatio) || 0);
  let mid = Math.max(0, Number(merged.midRatio) || 0);
  let tail = Math.max(0, Number(merged.tailRatio) || 0);
  const sum = head + mid + tail;

  if (sum <= 0) {
    head = DEFAULT_CONFIG.headRatio;
    mid = DEFAULT_CONFIG.midRatio;
    tail = DEFAULT_CONFIG.tailRatio;
  } else if (Math.abs(sum - 1.0) > 0.001) {
    head = Number((head / sum).toFixed(4));
    mid = Number((mid / sum).toFixed(4));
    tail = Number((1.0 - head - mid).toFixed(4));
  }

  return {
    enabled: merged.enabled === true,
    maxThinkingTokens,
    headRatio: head,
    midRatio: mid,
    tailRatio: tail,
    asciiWeight,
    nonAsciiWeight,
    keepThinkingTurns,
    lang: typeof merged.lang === 'string' ? merged.lang : 'zh',
  };
}
