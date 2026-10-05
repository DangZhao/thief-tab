'use strict';

/* ============================================================
 * Thief Tab —— 键位逻辑共享模块
 * content.js（网页注入）与 reader.js（速记页）共用，双份实现一旦漂移，
 * 同一 bossKey 配置在网页端与速记页的解析结果会不一致，极难排查。
 * 加载顺序：content_scripts 为 ["keys.js","content.js"]；reader.html 中
 * 必须先于 reader.js 引入。
 * 纯本地逻辑，无任何网络行为；不含页面可见文案（伪装面中性）。
 * ============================================================ */

/** 'Alt+Ctrl+Meta+Shift+Code' → {alt,ctrl,meta,shift,code}；'' 或纯修饰键 → null（禁用） */
function parseBossKey(spec) {
  const parts = String(spec || '').split('+').filter(Boolean);
  const code = parts[parts.length - 1];
  if (!code || ['Alt', 'Ctrl', 'Meta', 'Shift'].includes(code)) return null;
  return {
    code,
    alt: parts.includes('Alt'),
    ctrl: parts.includes('Ctrl'),
    meta: parts.includes('Meta'),
    shift: parts.includes('Shift'),
  };
}

/** 键盘事件是否命中老板键（修饰键须精确匹配） */
function matchBossKey(e, spec) {
  return !!spec && e.code === spec.code && e.altKey === spec.alt
    && e.ctrlKey === spec.ctrl && e.metaKey === spec.meta && e.shiftKey === spec.shift;
}

/** 键盘事件 → 键位串（固定顺序 Alt+Ctrl+Meta+Shift+Code） */
function formatBossKey(e) {
  const parts = [];
  if (e.altKey) parts.push('Alt');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Meta');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code);
  return parts.join('+');
}

/** 老板键是否与无修饰键的翻页键冲突（翻页键不响应组合键，带修饰键的老板键不可能冲突） */
function bossKeyConflictsFlip(spec, flipCode) {
  const b = parseBossKey(spec);
  return !!b && !b.alt && !b.ctrl && !b.meta && !b.shift && b.code === flipCode;
}

/** DigitN ↔ NumpadN 互为别名；其余键位单独生效 */
function expandKeyCodes(code) {
  const m = /^(Digit|Numpad)(\d)$/.exec(code || '');
  return m ? new Set(['Digit' + m[2], 'Numpad' + m[2]]) : new Set([code]);
}

// Node 单测导出（浏览器环境没有 module，忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseBossKey, matchBossKey, formatBossKey, bossKeyConflictsFlip, expandKeyCodes };
}
