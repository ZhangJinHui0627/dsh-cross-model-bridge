/**
 * dsh-cross-model-bridge - 事件持久化与原子落盘模块。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 500;

/**
 * 创建带防抖与原子落盘能力的事件记录器
 * @param {string} storageFile 本地持久化 JSON 路径
 */
export function createEventLog(storageFile) {
  let events = [];
  try {
    if (fs.existsSync(storageFile)) {
      const data = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      if (Array.isArray(data)) {
        events = data.slice(-MAX_EVENTS);
      }
    }
  } catch (err) {
    // 忽略损坏的旧文件
  }

  let saveTimer = null;
  function persistAtomic() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const tmpFile = `${storageFile}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(events, null, 2), 'utf8');
        fs.renameSync(tmpFile, storageFile);
      } catch (err) {
        // 忽略写入异常，防止影响主流程
      }
    }, 500);
    if (saveTimer && typeof saveTimer.unref === 'function') {
      saveTimer.unref();
    }
  }

  return {
    push(event) {
      events.push(event);
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }
      persistAtomic();
    },
    list() {
      return [...events];
    },
    get size() {
      return events.length;
    },
    destroy() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    },
    // 供单测直接清空或同步刷新
    _flushSync() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        const tmpFile = `${storageFile}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(events, null, 2), 'utf8');
        fs.renameSync(tmpFile, storageFile);
      } catch (e) {}
    },
  };
}
