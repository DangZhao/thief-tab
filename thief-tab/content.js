'use strict';

/* ============================================================
 * Thief Tab —— 网页注入（全局翻页 + 老板键）
 * 在所有 http/https 页面监听可配置的翻页键与老板键，通知后台转发给速记页。
 * 键位存 chrome.storage.local（settings.keyPrev / keyNext / bossKey），
 * 通过 storage.onChanged 实时生效，无需刷新页面。
 * 键位解析逻辑在 keys.js（先于本文件注入），与速记页共用同一实现。
 * 主键盘 DigitN 与小键盘 NumpadN 自动互为别名；NumLock 开关均有效；
 * 老板键（默认 Alt+KeyQ）支持 Alt/Ctrl/Meta/Shift 修饰键组合，修饰键精确匹配；
 * 输入框/文本域/可编辑元素内不劫持；纯本地，无任何网络行为。
 * ============================================================ */

(function () {
  // 注入自证标记：任意网页 Console 运行 document.documentElement.dataset.tabNotes 可验证
  try { document.documentElement.dataset.tabNotes = '1'; } catch (e) { /* 忽略 */ }

  const DEFAULT_PREV = 'Digit4';
  const DEFAULT_NEXT = 'Digit6';
  const DEFAULT_BOSS = 'Alt+KeyQ';
  let PREV = expandKeyCodes(DEFAULT_PREV);
  let NEXT = expandKeyCodes(DEFAULT_NEXT);
  let BOSS = parseBossKey(DEFAULT_BOSS);

  function loadKeys() {
    try {
      chrome.storage.local.get('settings', (d) => {
        const s = d && d.settings;
        PREV = expandKeyCodes(s && s.keyPrev ? s.keyPrev : DEFAULT_PREV);
        NEXT = expandKeyCodes(s && s.keyNext ? s.keyNext : DEFAULT_NEXT);
        BOSS = parseBossKey(s && typeof s.bossKey === 'string' ? s.bossKey : DEFAULT_BOSS);
      });
    } catch (e) { /* 上下文失效时沿用当前键位 */ }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadKeys();
  });
  loadKeys();

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }

  function report(type) {
    try {
      chrome.runtime.sendMessage({ type }, () => {
        if (chrome.runtime.lastError) {
          // 速记页未开（no-reader）属正常静默；其余（如扩展刚更新导致接收端丢失）给出可见提示
          console.warn('[Thief Tab] 按键转发失败：' + chrome.runtime.lastError.message +
            '。若扩展刚更新/重载过，请刷新本页面（F5）后重试。');
        }
      });
    } catch (e) {
      // 扩展重载/移除后本页残留旧注入脚本：上下文已失效，必须 F5 刷新才能恢复
      console.warn('[Thief Tab] 按键不可用：扩展已更新或重新加载，本页面的连接已失效，请刷新本页面（F5）。');
    }
  }

  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;                    // 输入类元素不劫持
    if (matchBossKey(e, BOSS)) {                         // 老板键：修饰键精确匹配，优先于翻页键
      e.preventDefault();
      report('toggle-boss-key');
      return;
    }
    const isPrev = PREV.has(e.code);
    const isNext = NEXT.has(e.code);
    if (!isPrev && !isNext) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;      // 组合键不劫持（NumLock 关闭时小键盘数字会移动光标/滚动）
    e.preventDefault();
    report(isNext ? 'page-next' : 'page-prev');
  }, true);
})();
