/**
 * dsh-cross-model-bridge - 三段式思维预算抽取与代码块安全围栏引擎。
 */

export const DEFAULT_ANCHOR_REGEX = new RegExp(
  [
    '排除|放弃|不能|不要|避免|不可行|根因|报错|失败|冲突|坑|注意|约束|必须|关键|最终|决定|结论|改用|权衡|前提',
    '\\b(?:instead|avoid|cannot|can\'t|won\'t|root cause|error|fail(?:ed)?|conflict|constraint|must|decid(?:e|ed)|conclusion|worth|key)\\b',
  ].join('|'),
  'i',
);

/** 中英双语加权 Token 估算 */
export function estimateTokens(text, asciiWeight = 0.25, nonAsciiWeight = 1.0) {
  if (!text || typeof text !== 'string') return 0;
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    sum += text.charCodeAt(i) <= 0x7f ? asciiWeight : nonAsciiWeight;
  }
  return Math.ceil(sum);
}

/** 代码块安全围栏扫描（支持 ``` 与 ~~~） */
export function getFenceRanges(text) {
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

/** 避免截断 UTF-16 代理对 */
export function avoidSurrogateSplit(text, idx, moveForward = false) {
  if (idx <= 0 || idx >= text.length) return idx;
  const code = text.charCodeAt(idx);
  if (code >= 0xdc00 && code <= 0xdfff) {
    return moveForward ? idx + 1 : idx - 1;
  }
  return idx;
}

/** 按 Token 预算寻找切点 */
export function findIndexByBudget(text, budget, fromEnd = false, asciiWeight = 0.25, nonAsciiWeight = 1.0) {
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

/** 语义边界吸附（优先段落 -> 换行 -> 句末标点） */
export function snapHeadEnd(text, rawEnd) {
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

export function snapTailStart(text, rawStart) {
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

/** 修正落在代码块内部的切点（头部后退，尾部前进） */
export function guardHeadFence(endIdx, fenceRanges) {
  for (const r of fenceRanges) {
    if (r.start < endIdx && endIdx < r.end) {
      return r.start; // 退回到代码块开始之前，丢弃残缺前段
    }
  }
  return endIdx;
}

export function guardTailFence(startIdx, fenceRanges) {
  for (const r of fenceRanges) {
    if (r.start < startIdx && startIdx < r.end) {
      return r.end; // 前进到代码块结束之后，丢弃残缺后段
    }
  }
  return startIdx;
}

/** 中段决策锚点抽取（跳过代码块并做正文去重） */
export function extractMiddleAnchors(text, startIdx, endIdx, fenceRanges, options) {
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
    let m;
    while ((m = sentenceRegex.exec(chunk)) !== null) {
      const sentence = m[0].trim();
      if (sentence.length < 8) continue;
      if (!anchorRegex.test(sentence)) continue;

      const norm = sentence.replace(/\s+/g, '');
      if (seen.has(norm)) continue;
      if (normalizedReply && norm.length >= 16 && normalizedReply.includes(norm)) {
        continue; // 正文已完整说明的句子不重复占用思考预算
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

/** 三段式思考链智能抽取引擎 */
export function extractThinkingSummary(thinking, opts = {}) {
  if (typeof thinking !== 'string') return { summary: '', stats: null };
  const text = thinking.replace(/\r\n/g, '\n').trim();
  if (!text) return { summary: '', stats: null };

  const maxTokens = opts.maxThinkingTokens || 500;
  const headRatio = opts.headRatio ?? 0.15;
  const midRatio = opts.midRatio ?? 0.25;
  const asciiWeight = opts.asciiWeight ?? 0.25;
  const nonAsciiWeight = opts.nonAsciiWeight ?? 1.0;

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
