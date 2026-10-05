'use strict';

/* ============================================================
 * Thief Tab —— 后台（MV3 service worker）
 * 职责：工具栏按钮打开/聚焦速记页；老板键与翻页键转发；联动组成员表管理。
 * 注意：SW 会休眠，跨页面状态一律读 chrome.storage.session，不依赖内存常驻。
 * ============================================================ */

const MEMBER_KEY = 'members';
const READER_PAGE = 'reader.html';
const MAX_MEMBERS = 3; // 速记页上限；与 reader.js 的 MAX_TABS 同源，调整时两处同步改

async function getMembers() {
  try {
    const data = await chrome.storage.session.get(MEMBER_KEY);
    const list = data && data[MEMBER_KEY];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[Thief Tab] 读取成员表失败：', e && e.message); // 留痕：静默降级为空组会让故障无从排查
    return [];
  }
}

/** 成员表按标签栏顺序排序并过滤已关闭的成员 */
async function sortedAliveMembers() {
  const members = await getMembers();
  let all = [];
  try { all = await chrome.tabs.query({}); } catch (e) { return members; }
  const byId = new Map(all.map((t) => [t.id, t]));
  const alive = members.filter((m) => byId.has(m.tabId));
  alive.sort((a, b) => {
    const ta = byId.get(a.tabId);
    const tb = byId.get(b.tabId);
    return (ta.windowId - tb.windowId) || (ta.index - tb.index);
  });
  return alive;
}

/** 向标签页发消息；冻结/无响应的页面会在超时后返回 null（避免挂死转发链） */
function sendMessageWithTimeout(tabId, msg, timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      chrome.tabs.sendMessage(tabId, msg).then((r) => finish(r || null)).catch(() => finish(null));
    } catch (e) {
      finish(null);
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** 并行广播：互不阻塞，整体耗时 = 最慢单个超时而非逐个累加（老板键等延迟敏感路径用） */
async function broadcastTo(alive, msg, timeoutMs = 600) {
  await Promise.allSettled(alive.map((m) => sendMessageWithTimeout(m.tabId, msg, timeoutMs)));
}

// 工具栏按钮：未满 3 个时新开一个速记页，满员则聚焦第一个
chrome.action.onClicked.addListener(async () => {
  const alive = await sortedAliveMembers();
  if (alive.length >= MAX_MEMBERS) {
    try {
      const t = await chrome.tabs.get(alive[0].tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }); // 跨窗口时前置所属窗口，避免「点了没反应」
    } catch (e) { /* 标签已关闭等：忽略 */ }
    return;
  }
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(READER_PAGE) });
  } catch (e) { /* 创建失败：忽略，避免 SW 内未处理的 Promise 拒绝 */ }
});

// 网页注入（content.js）的消息：老板键（settings.bossKey，默认 Alt+Q）与翻页键。
// 老板键广播给全部速记页，全组一起伪装；翻页请求按标签栏顺序逐个尝试成员
// （冻结页超时换下一个），第一个成功执行的成员会负责把新位置同步给组内其他成员。
// 消息带 fromCharIndex（转发时的组基准），接收方据此幂等处理，避免冻结页解冻后排队消息造成重复翻页。
// 应答语义：resp.ok 仅在该成员「真正处理了请求」（翻页 / 幂等对齐 / 到边界提示）时为 true；
// 书架态 / 伪装态成员回 ok:false，转发链继续尝试下一个成员——否则组内第一个成员停在
// 书架时会吞掉整条翻页请求，其他在读书的成员永远收不到（表现：网页按 6 无声无息）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'reload-settings') {
    // 设置被外部（如直接写 storage）修改：通知全部成员重读设置
    (async () => {
      const alive = await sortedAliveMembers();
      await broadcastTo(alive, { type: 'sync' }, 600);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === 'toggle-boss-key') {
    (async () => {
      const alive = await sortedAliveMembers();
      await broadcastTo(alive, { type: 'toggle-title-mask' }, 600);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (!msg || (msg.type !== 'page-next' && msg.type !== 'page-prev')) return undefined;
  (async () => {
    const alive = await sortedAliveMembers();
    let fromCharIndex;
    try {
      const d = await chrome.storage.session.get('base');
      const base = d && d.base;
      if (base && typeof base.charIndex === 'number') fromCharIndex = base.charIndex;
    } catch (e) { /* 忽略 */ }
    for (const m of alive) {
      const resp = await sendMessageWithTimeout(m.tabId, { type: msg.type, fromCharIndex }, 800);
      if (resp && resp.ok) {
        sendResponse({ ok: true });
        return;
      }
    }
    sendResponse({ ok: false, reason: alive.length ? 'reader-frozen' : 'no-reader' });
  })();
  return true; // 异步应答
});

// 成员标签关闭时更新成员表，并通知剩余成员按新顺序重排。
// 写后重读校验：本表的「读→过滤→写」与 joinGroup 的「读→push→写」并发时后写会覆盖
// 先写（复活已删成员 / 丢新成员）。此处检测到本 tabId 复活即重试（有限次数）；
// 反向（joinGroup 被 onRemoved 覆盖）由 joinGroup 的写后重读自愈兜底。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const members = await getMembers();
  if (!members.some((m) => m.tabId === tabId)) return;
  const rest = members.filter((m) => m.tabId !== tabId);
  for (let i = 0; i < 3; i++) {
    try { await chrome.storage.session.set({ [MEMBER_KEY]: rest }); } catch (e) { break; }
    if (!(await getMembers()).some((m) => m.tabId === tabId)) break; // 写入未被并发注册覆盖
  }
  await broadcastTo(rest, { type: 'sync' }, 600);
});

// 标签因预渲染激活 / 进程替换而更换 tabId：同步成员表，否则该速记页会被存活过滤
// 当作已关闭而静默脱离联动（收不到 sync / 翻页转发，也不参与行序计算，无法自愈）。
// 新页面的 joinGroup 会按 tabId 去重清掉旧化身，token 亦不同，不会重复入组。
chrome.tabs.onReplaced.addListener(async (newTabId, oldTabId) => {
  const members = await getMembers();
  if (!members.some((m) => m.tabId === oldTabId)) return;
  const next = members.map((m) => (m.tabId === oldTabId ? { ...m, tabId: newTabId } : m));
  try { await chrome.storage.session.set({ [MEMBER_KEY]: next }); } catch (e) { /* 忽略 */ }
  await broadcastTo(next, { type: 'sync' }, 600);
});

// 标签被拖动重排时通知全部成员重算自己的行序。
// 拖动过程中 onMoved 会高频连续触发（每经过一个位置一次），每次全量 tabs.query +
// 组广播 + 成员全量重渲染开销大：加短防抖，停稳后只同步一次。
let moveSyncTimer = null;
chrome.tabs.onMoved.addListener(() => {
  if (moveSyncTimer) clearTimeout(moveSyncTimer);
  moveSyncTimer = setTimeout(async () => {
    moveSyncTimer = null;
    const alive = await sortedAliveMembers();
    await broadcastTo(alive, { type: 'sync' }, 600);
  }, 150);
});
