'use strict';

/* ============================================================
 * Thief Tab —— 阅读页
 * 正文按页写入 document.title；← → 翻页；Esc / Alt+Q 切换标题伪装。
 * 纯本地运行：仅使用 chrome.storage 与 IndexedDB，无任何网络请求。
 * ============================================================ */

// ---------- 常量 ----------
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 单文件上限 50MB
const MIN_VALID_CHARS = 100;             // 有效字符下限
const PAGE_SIZE_MIN = 8;
const PAGE_SIZE_MAX = 60;
const SAVE_THROTTLE_MS = 800;            // 进度写入节流（≤1s）
const MAX_SEARCH_MATCHES = 2000;         // 搜索匹配封顶（超长文本防全量收集卡顿，截断以「+」提示）
const NEUTRAL_TITLE = 'Thief Tab';
const BREAK_CHARS = new Set(['\n', '。', '！', '？', '…', '；', '，', '、']);
const BREAK_CODES = new Set([10, 12290, 65281, 65311, 8230, 65307, 65292, 12289]);
const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'gbk': 'GBK',
  'gb18030': 'GB18030',
  'big5': 'Big5',
};
const DEFAULT_SETTINGS = {
  pageSize: 16,        // 页大小（字）
  encoding: 'auto',    // 导入编码：auto | utf-8 | gbk | gb18030 | big5
  disguiseTitle: '新标签页',
  prefixEnabled: false,
  prefixText: '',
  showPageText: true,  // 阅读页内显示正文
  keyPrev: 'Digit4',   // 上一页按键（e.code；DigitN 与 NumpadN 自动互通）
  keyNext: 'Digit6',   // 下一页按键
  bossKey: 'Alt+KeyQ', // 老板键（修饰键+e.code，如 Alt+KeyQ / Ctrl+Shift+KeyB；'' = 禁用；Esc 在速记页内始终可切换）
  flipMode: 'block',   // 翻页方式：block = 整页（一次翻过整组行数）| line = 逐行（一次一行）
  slotFavicons: ['', '', ''], // 第 1/2/3 个标签位各自的图标（dataURL 或网址，空 = 默认）
};

// ---------- 纯逻辑（与 DOM 无关，可在 Node 中单测） ----------

/** 去 BOM、统一换行、规范化空白字符 */
function normalizeText(raw) {
  let s = String(raw);
  s = s.replace(/^\uFEFF+/, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/\u200b/g, '');
  s = s.replace(/[\u00A0\u2007\u202F\u3000]/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

/** 有效字符数（非空白字符；代理对按 1 计）。循环实现，避免大文本生成巨型匹配数组 */
const WS_CODES = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
function countValidChars(s) {
  const str = String(s);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // 代理对低位不重复计
    if (WS_CODES.has(c) || (c >= 0x2000 && c <= 0x200a)) continue;
    n++;
  }
  return n;
}

function decodeByLabel(u8, label) {
  return new TextDecoder(label).decode(u8);
}

/** 无 BOM UTF-16 字节粗检：NUL 字节密度高（含 ASCII 内容的 UTF-16 几乎必有大量 NUL；UTF-8/GBK 正文不含 0x00） */
function looksUtf16Bytes(u8) {
  const n = Math.min(u8.length, 8192);
  if (n < 8) return false;
  let z = 0;
  for (let i = 0; i < n; i++) if (u8[i] === 0) z++;
  return z / n > 0.05;
}

/** 已解出文本里 NUL 字符密度高：UTF-8 严格解码「成功」但结果实为无 BOM UTF-16 的假象 */
function looksUtf16Text(t) {
  const n = Math.min(t.length, 4096);
  if (n < 8) return false;
  let z = 0;
  for (let i = 0; i < n; i++) if (t.charCodeAt(i) === 0) z++;
  return z / n > 0.02;
}

/** 无 BOM UTF-16 的字节序判定：NUL 密度高按 NUL 所在奇偶位（ASCII 类内容，LE 的 NUL 落在奇数位）；
 *  否则按 CJK 字密度（中日韩正文在错误字节序下密度显著更低）。 */
function decodeUtf16Auto(u8) {
  const n = Math.min(u8.length, 8192) & ~1;
  let zerosEven = 0;
  let zerosOdd = 0;
  for (let i = 0; i < n; i += 2) {
    if (u8[i] === 0) zerosEven++;
    if (u8[i + 1] === 0) zerosOdd++;
  }
  let label;
  if (n > 0 && (zerosEven + zerosOdd) / n > 0.3) {
    label = zerosOdd >= zerosEven ? 'utf-16le' : 'utf-16be';
  } else {
    const end = Math.min(u8.length, 4096) & ~1;
    const cjkCount = (t) => {
      let c = 0;
      for (let i = 0; i < t.length; i++) {
        const c2 = t.charCodeAt(i);
        if ((c2 >= 0x3400 && c2 <= 0x9fff) || (c2 >= 0x3000 && c2 <= 0x303f) || (c2 >= 0xff00 && c2 <= 0xffef)) c++;
      }
      return c;
    };
    const le = decodeByLabel(u8.subarray(0, end), 'utf-16le');
    const be = decodeByLabel(u8.subarray(0, end), 'utf-16be');
    label = cjkCount(le) >= cjkCount(be) ? 'utf-16le' : 'utf-16be';
  }
  return { text: decodeByLabel(u8, label), encoding: label === 'utf-16le' ? 'UTF-16LE' : 'UTF-16BE' };
}

/**
 * 编码处理：BOM 优先；手动指定走白名单；
 * 自动模式依次：UTF-16 字节粗检 → UTF-8 严格解码（成功但 NUL 密度高仍按 UTF-16 处理）→
 * GB18030 严格试探（GBK 为其子集；试探失败极可能是无 BOM UTF-16）→ GB18030 宽松兜底。
 */
function detectAndDecode(buf, manual) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return { text: decodeByLabel(u8.slice(3), 'utf-8'), encoding: 'UTF-8' };
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return { text: decodeByLabel(u8.slice(2), 'utf-16le'), encoding: 'UTF-16LE' };
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return { text: decodeByLabel(u8.slice(2), 'utf-16be'), encoding: 'UTF-16BE' };
  }
  if (manual && manual !== 'auto' && ENCODING_LABELS[manual]) {
    return { text: decodeByLabel(u8, manual), encoding: ENCODING_LABELS[manual] };
  }
  if (looksUtf16Bytes(u8)) return decodeUtf16Auto(u8);
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    if (looksUtf16Text(t)) return decodeUtf16Auto(u8);
    return { text: t, encoding: 'UTF-8' };
  } catch (e) { /* 不是 UTF-8 */ }
  try {
    new TextDecoder('gb18030', { fatal: true }).decode(u8); // 必须整本严格解码：截断样本会把多字节序列切一半造成假失败
  } catch (e) {
    return decodeUtf16Auto(u8); // UTF-8 与 GB18030 严格解码都失败：极可能是无 BOM 的 UTF-16
  }
  return { text: decodeByLabel(u8, 'gb18030'), encoding: 'GB18030' };
}

/**
 * 按字数分页：返回页起始下标数组 starts，页 i = text.slice(starts[i], starts[i+1])。
 * 断页点优先取页尾附近（size 的一半窗口内）最后一个断点之后；
 * 页尾附近无断点、但页尾后不远（size 的四分之一）有断点则顺延到那里；
 * 附近都没有才在整 size 处硬切。
 */
function computePageStarts(text, size) {
  const n = text.length;
  const starts = [];
  let i = 0;
  while (i < n) {
    starts.push(i);
    const end = i + size;
    if (end >= n) break;
    const back = Math.max(2, Math.floor(size / 2));
    const searchFrom = Math.max(i + 1, end - back);
    let cut = -1;
    for (let j = end; j >= searchFrom; j--) {
      if (BREAK_CODES.has(text.charCodeAt(j - 1))) { cut = j; break; }
    }
    if (cut < 0) {
      const fwd = Math.max(2, Math.floor(size / 4));
      const limit = Math.min(n, end + fwd);
      for (let j = end + 1; j <= limit; j++) {
        if (BREAK_CODES.has(text.charCodeAt(j - 1))) { cut = j; break; }
      }
    }
    if (cut < 0) cut = end; // 硬切
    if (cut < n) {
      const c = text.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut = Math.min(cut + 1, n); // 不切开代理对
    }
    if (cut <= i) cut = Math.min(i + 1, n); // 保底至少前进一字
    i = cut;
  }
  if (starts[starts.length - 1] !== n) starts.push(n);
  return starts;
}

/** 二分查找 charIndex 所在页下标 */
function findPageIndex(starts, charIndex) {
  let lo = 0;
  let hi = starts.length - 2;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= charIndex) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** 页面文字 → 标题文字：折叠空白；空页兜底 */
function pageToTitle(slice) {
  const t = String(slice).replace(/\s+/g, ' ').trim();
  return t || '……';
}

/** 搜索匹配收集：正则转义后全量扫描，达到 cap 即停（超长文本防卡顿），truncated 标记截断 */
function collectMatches(text, query, cap) {
  const matches = [];
  let truncated = false;
  if (!text || !query) return { matches, truncated };
  const re = new RegExp(escapeRegExp(query), 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push(m.index);
    if (matches.length >= cap) { truncated = true; break; }
    if (m.index === re.lastIndex) re.lastIndex++; // 零长匹配保护
  }
  return { matches, truncated };
}

// ---------- 章节识别（纯逻辑，可在 Node 中单测） ----------
// 「的」负向断言排除「第1章的第二段继续叙述…」这类以章号开头的散文行
const CHAPTER_LINE_RE = /^[ \t]*(?:第[ \t]*[0-9〇零一二两三四五六七八九十百千万]+[ \t]*[章节回卷部篇集](?!的)|卷[ \t]*[0-9〇零一二两三四五六七八九十百千万]+(?!的)|序章|楔子|尾声|后记|番外)/;
const CHAPTER_LINE_FIRST = new Set([0x7b2c, 0x5377, 0x5e8f, 0x6954, 0x5c3e, 0x540e, 0x756a]); // 第 卷 序 楔 尾 后 番
const CHAPTER_LINE_MAX = 20; // 标题行长度上限：排除以「第X章」开头的长叙述段落

/** 扫描全文按行识别章节标题行，返回章节起始 charIndex 数组（升序；无章节则空数组） */
function parseChapterStarts(text) {
  const s = String(text);
  const starts = [];
  let lineStart = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i < s.length && s.charCodeAt(i) !== 10) continue;
    const lineLen = i - lineStart;
    if (lineLen > 0 && lineLen <= CHAPTER_LINE_MAX && CHAPTER_LINE_FIRST.has(s.charCodeAt(lineStart))) {
      if (CHAPTER_LINE_RE.test(s.slice(lineStart, i))) starts.push(lineStart);
    }
    lineStart = i + 1;
  }
  return starts;
}

/** 二分查找 charIndex 所在章下标（0 起；首章之前返回 0） */
function findChapterIndex(chapterStarts, charIndex) {
  let lo = 0;
  let hi = chapterStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapterStarts[mid] <= charIndex) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** 当前页所含内容的章号（0 起）：取页尾前最后一个章节起点——
 *  页内出现下一章开头即显示新章（目录跳章后立即见目标章号），纯页中段则显示所属章 */
function chapterOfPageIndex(starts, chapterStarts, baseIdx, textLen) {
  const pageEnd = baseIdx + 1 < starts.length ? Number(starts[baseIdx + 1]) : textLen;
  return findChapterIndex(chapterStarts, Math.max(0, pageEnd - 1));
}

// ---------- 老板键键位 ----------
// parseBossKey / matchBossKey / formatBossKey / bossKeyConflictsFlip / expandKeyCodes
// 在 keys.js（本文件之前加载，Node 单测亦可直接 require），此处不再保留副本。

/** 导入字节 SHA-256（对原始文件字节；用于重复导入判重，不同编码的同内容文本视为不同条目） */
async function sha256Hex(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- 运行状态 ----------
let settings = { ...DEFAULT_SETTINGS };
let books = []; // [{id,title,encoding,addedAt,totalChars,charIndex,updatedAt}]
let currentBookId = null;
let readingText = '';
let charIndex = 0;       // 组基准页首（联动组共享的进度）
let disguised = false;
let myTabId = null;
let myToken = null;      // 本页在联动组中的身份
let isMember = false;    // 已加入联动组（或降级单页模式）
let myRank = 0;          // 本页在标签栏中的序号（0 = 第 1 行）
let groupSize = 1;       // 联动组当前成员数（正文区显示的行数 = 标签栏同时显示的行数）
let saveTimer = null;
let lastToggleAt = 0;
let settingsReturn = 'shelf';
let bootDone = false;
let groupLostNotified = false;
let bootReadyResolve = null;
const bootReady = new Promise((r) => { bootReadyResolve = r; });
const pageCache = new Map(); // 'bookId|size' -> starts（最多缓存 2 本，防大书占内存）
let chapterStarts = null;    // 当前书的章节起始下标数组（null = 未加载；[] = 已加载但无章节标题）

const $ = (sel) => document.querySelector(sel);

// ---------- IndexedDB（原文 / 分页 / 章节） ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tab-notes-db', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', { keyPath: 'bookId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 单事务封装：op 操作 objectStore，事务完成时 resolve 其请求结果，finally 关闭连接 */
function idbTx(store, mode, op) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    let result;
    try {
      const tx = db.transaction(store, mode);
      const rq = op(tx.objectStore(store));
      if (rq) rq.onsuccess = () => { result = rq.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
    } catch (e) {
      reject(e);
    }
  }).finally(() => db.close()));
}

const putBookText = (id, text) => idbTx('texts', 'readwrite', (s) => s.put({ id, text }));
const getBookText = (id) => idbTx('texts', 'readonly', (s) => s.get(id)).then((r) => (r ? r.text : undefined));
const deleteBookText = (id) => idbTx('texts', 'readwrite', (s) => s.delete(id));

// 分页结果持久化：键 'bookId|size'，值为 Uint32Array 页起始下标（大书重开免重算）
const putPageStarts = (key, starts) => idbTx('pages', 'readwrite', (s) => s.put({ key, starts }));
const getPageStarts = (key) => idbTx('pages', 'readonly', (s) => s.get(key)).then((r) => (r ? r.starts : undefined));
const deletePageStartsForBook = (bookId) => idbTx('pages', 'readwrite', (s) => s.delete(IDBKeyRange.bound(bookId + '|', bookId + '|\uffff')));

// 全局页大小变更时整体失效分页缓存：旧 size 的记录此后不会再被命中，清掉防 IndexedDB 无界膨胀
const clearAllPageStarts = () => idbTx('pages', 'readwrite', (s) => s.clear());

// 章节起始持久化：键 bookId
const putChapters = (bookId, starts) => idbTx('chapters', 'readwrite', (s) => s.put({ bookId, starts }));
const getChapters = (bookId) => idbTx('chapters', 'readonly', (s) => s.get(bookId)).then((r) => (r ? r.starts : undefined));
const deleteChapters = (bookId) => idbTx('chapters', 'readwrite', (s) => s.delete(bookId));

// ---------- 提示 ----------
let noticeTimer = null;
function showNotice(msg, ms) {
  const el = $('#notice');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
}

// ---------- 导入 ----------
async function importFiles(fileList) {
  const files = Array.from(fileList || []); // 必须同步拷贝：调用方会立即清空 input.value
  if (!bootDone) await bootReady;      // 等 loadState 完成，避免用空的 books 数组覆写书架
  if (window.__tnrYielded) return;     // 本页已让位、即将关闭
  if (!(await stillInGroup())) return;   // 已不在联动组中，不再写入
  if (!files.length) return;
  let imported = 0;
  for (const file of files) {
    try {
      const isTxt = /\.txt$/i.test(file.name);
      const isEpub = /\.epub$/i.test(file.name);
      if (!isTxt && !isEpub) {
        showNotice('仅支持 .txt / .epub 文件：「' + file.name + '」已跳过');
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        showNotice(`「${file.name}」超过 50MB 上限（${(file.size / 1024 / 1024).toFixed(1)}MB），已拒绝`);
        continue;
      }
      if (file.size === 0) {
        showNotice(`「${file.name}」是空文件，已拒绝`);
        continue;
      }
      const buf = await file.arrayBuffer();
      const hash = await sha256Hex(buf);
      // 重复导入判重：同字节文件只保留一条（读 storage 最新列表，防多页并发漏判）
      let latest = books;
      try {
        const st = await chrome.storage.local.get('books');
        if (Array.isArray(st.books)) latest = st.books;
      } catch (e) { /* 忽略 */ }
      if (latest.some((b) => b && b.hash === hash)) {
        showNotice(`「${file.name}」内容已存在，已跳过`);
        continue;
      }
      let rawText;
      let encoding;
      let title;
      if (isEpub) {
        let parsed;
        try {
          parsed = await parseEpub(buf);
        } catch (err) {
          showNotice(`解析 EPUB 失败：${err && err.message ? err.message : '未知错误'}`);
          continue;
        }
        rawText = parsed.text;
        encoding = 'EPUB';
        title = parsed.title || file.name.replace(/\.epub$/i, '') || '未命名';
      } else {
        const decoded = detectAndDecode(buf, settings.encoding);
        rawText = decoded.text;
        encoding = decoded.encoding;
        title = file.name.replace(/\.txt$/i, '') || '未命名';
      }
      const normText = normalizeText(rawText);
      if (countValidChars(normText) < MIN_VALID_CHARS) {
        showNotice(`「${file.name}」有效字符不足 100，已拒绝`);
        continue;
      }
      const id = 'bk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      await putBookText(id, normText);
      const meta = {
        id, title, encoding, hash,
        addedAt: Date.now(),
        totalChars: normText.length,
        charIndex: 0,
        updatedAt: Date.now(),
      };
      // 读-改-写并入书目列表（防多速记页旧数组互相覆盖）；并发竞态下再次判重
      const merged = await mergeBooksWrite((list) => {
        if (list.some((b) => b && b.hash === hash)) return null;
        list.push(meta);
        return list;
      });
      if (!merged) {
        try { await deleteBookText(id); } catch (e) { /* 忽略 */ }
        showNotice(`「${file.name}」内容已存在，已跳过`);
        continue;
      }
      imported++;
      showNotice(`已导入「${title}」（${encoding}，共 ${normText.length} 字）`);
    } catch (err) {
      showNotice(`导入「${file.name}」失败：${err && err.message ? err.message : '未知错误'}`);
    }
  }
  if (imported > 0) broadcastRaw({ type: 'sync' }); // 新书必须同步其他速记页，否则其旧 books 副本下次落盘会把新书覆盖掉
  renderShelf();
}

// ---------- 进度保存（节流 ≤1s，隐藏/离开时强制落盘） ----------
function scheduleSaveProgress() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveProgressNow(); }, SAVE_THROTTLE_MS);
}

/** 校验本页仍在联动组中；被移出时提示一次并停止后续写入 */
async function stillInGroup() {
  if (!isMember) return false;
  try {
    const data = await chrome.storage.session.get('members');
    const list = Array.isArray(data && data.members) ? data.members : [];
    if (!list.some((m) => m.token === myToken)) {
      if (!groupLostNotified) {
        groupLostNotified = true;
        isMember = false;
        showNotice('本页已不在联动组中，内容与进度将不再保存', 4000);
      }
      return false;
    }
    return true;
  } catch (e) {
    return true; // session 不可用时不再校验
  }
}

/** books 读-改-写：以 storage 里最新列表为基底应用 mutator 后整体写回，并同步进内存 books。
 *  多速记页各自持有 books 副本，直接整写会用旧数组覆盖掉其他页刚写入的内容（如新书消失），必须走合并。 */
async function mergeBooksWrite(mutator) {
  let base = books;
  try {
    const st = await chrome.storage.local.get('books');
    if (Array.isArray(st.books)) base = st.books;
  } catch (e) { /* 读失败：退回内存副本 */ }
  base = base.filter((b) => b && typeof b.id === 'string'); // 元素级清洗：写回时永久剔除坏元素（自愈）
  let next = null;
  try { next = mutator(base.slice()); } catch (e) { return false; }
  if (!next) return false;
  books = next;
  try {
    await chrome.storage.local.set({ books });
    return true;
  } catch (e) { return false; }
}

async function saveProgressNow(force) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!currentBookId || !isMember) return;
  if (!force && !(await stillInGroup())) return;
  const adopted = await adoptGroupBase(); // 采纳组内最新基准（防冻结的旧页面用旧进度覆盖新进度）
  if (adopted) applyTitle(); // 基准可能已被他页推进：顺手对齐标题，消除显示与已存进度的短暂不一致
  const bookId = currentBookId;
  const written = await mergeBooksWrite((list) => {
    const i = list.findIndex((b) => b.id === bookId);
    if (i < 0) return null; // 书已被其他页删除：不复活
    list[i] = { ...list[i], charIndex, updatedAt: Date.now() };
    return list;
  });
  if (!written) return;
  try {
    await chrome.storage.local.set({ currentBookId: bookId });
  } catch (e) { /* 落盘失败则等下次节流再试 */ }
}

function flushProgress(force) {
  saveProgressNow(force === true);
}

// ---------- 联动组（最多 3 个速记页，storage.session + tabs API） ----------
const MAX_TABS = 3;

function makeToken() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 读取成员表并按标签栏顺序排序，过滤已不存在的成员 */
async function listAliveMembers() {
  let members = [];
  try {
    const data = await chrome.storage.session.get('members');
    members = Array.isArray(data && data.members) ? data.members : [];
  } catch (e) { /* session 不可用 */ }
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

/** 加入联动组；满 3 个时提示并聚焦现有页面、本页自毁 */
async function joinGroup() {
  try {
    const tab = await chrome.tabs.getCurrent();
    myTabId = tab ? tab.id : null;
  } catch (e) { myTabId = null; }
  myToken = makeToken();
  if (myTabId == null) { // 无法定位自身标签页：降级为独立单页
    isMember = true;
    myRank = 0;
    return true;
  }
  let members = [];
  try {
    const data = await chrome.storage.session.get('members');
    members = Array.isArray(data && data.members) ? data.members : [];
  } catch (e) { /* session 不可用则视为空组 */ }
  // 过滤已关闭的成员 + 移除自己（bfcache/刷新重入场景：同一 tabId 的旧化身一律清掉）
  try {
    const all = await chrome.tabs.query({});
    const ids = new Set(all.map((t) => t.id));
    members = members.filter((m) => ids.has(m.tabId) && m.token !== myToken && m.tabId !== myTabId);
  } catch (e) { /* 忽略 */ }
  if (members.length >= MAX_TABS) {
    try {
      const t = await chrome.tabs.get(members[0].tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    } catch (e) { /* 忽略 */ }
    showNotice(`速记页最多同时打开 ${MAX_TABS} 个，已为你聚焦现有页面`);
    setTimeout(() => { try { chrome.tabs.remove(myTabId); } catch (e) { /* 忽略 */ } }, 900);
    return false;
  }
  members.push({ tabId: myTabId, token: myToken });
  try {
    await chrome.storage.session.set({ members });
    // 防并发：写后重读，自己的记录被覆盖视为满员
    const check = await chrome.storage.session.get('members');
    const list = Array.isArray(check && check.members) ? check.members : [];
    if (!list.some((m) => m.token === myToken)) {
      if (list.length) {
        try {
          const t = await chrome.tabs.get(list[0].tabId);
          await chrome.tabs.update(t.id, { active: true });
          await chrome.windows.update(t.windowId, { focused: true });
        } catch (e) { /* 忽略 */ }
      }
      showNotice(`速记页最多同时打开 ${MAX_TABS} 个`);
      setTimeout(() => { try { chrome.tabs.remove(myTabId); } catch (e) { /* 忽略 */ } }, 900);
      return false;
    }
    isMember = true;
    return true;
  } catch (e) {
    isMember = true; // session 不可用时降级为独立单页
    myRank = 0;
    return true;
  }
}

/** 离开联动组（页面关闭/导航时） */
function leaveGroup() {
  if (!isMember) return;
  isMember = false;
  try {
    chrome.storage.session.get('members').then((data) => {
      const list = (Array.isArray(data && data.members) ? data.members : []).filter((m) => m.token !== myToken);
      return chrome.storage.session.set({ members: list });
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/** 向标签页发消息；冻结/无响应的页面在超时后返回 null（避免广播链挂死） */
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

/** 把自己的最新基准广播给其他成员（写 session.base + 逐个通知） */
async function broadcastSync(extra) {
  try { await chrome.storage.session.set({ base: { bookId: currentBookId, charIndex } }); } catch (e) { /* 忽略 */ }
  await broadcastRaw({ type: 'sync', charIndex, bookId: currentBookId, ...extra });
}

/** 向组内其他成员发消息（不含自己） */
async function broadcastRaw(msg) {
  let alive = [];
  try { alive = await listAliveMembers(); } catch (e) { return; }
  for (const m of alive) {
    if (m.token === myToken) continue;
    await sendMessageWithTimeout(m.tabId, msg, 800);
  }
}

// ---------- 状态读取 / 设置 ----------
function clampPageSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.pageSize;
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.round(n)));
}

async function loadState() {
  let st = {};
  try {
    st = await chrome.storage.local.get(['settings', 'books', 'currentBookId']);
  } catch (e) { /* 用默认值 */ }
  settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  settings.pageSize = clampPageSize(settings.pageSize);
  settings.flipMode = settings.flipMode === 'line' ? 'line' : 'block';
  if (typeof settings.bossKey !== 'string') settings.bossKey = DEFAULT_SETTINGS.bossKey; // '' 允许 = 禁用
  if (!settings.disguiseTitle) settings.disguiseTitle = DEFAULT_SETTINGS.disguiseTitle;
  // 旧版单图标设置迁移到三槽位的第 1 槽
  if (!Array.isArray(settings.slotFavicons)) {
    settings.slotFavicons = [settings.faviconData || settings.faviconUrl || '', '', ''];
  }
  while (settings.slotFavicons.length < MAX_TABS) settings.slotFavicons.push('');
  settings.slotFavicons.length = MAX_TABS;
  books = Array.isArray(st.books)
    ? st.books.filter((b) => b && typeof b.id === 'string' && typeof b.title === 'string')
    : []; // 元素级清洗：坏元素在读取边界剔除，renderShelf / openBook 等遍历全部安全
  currentBookId = typeof st.currentBookId === 'string' ? st.currentBookId : null;
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings });
    broadcastSync({ settingsSynced: true }); // 键位/页大小/图标等设置全组同步
  } catch (e) { /* 忽略 */ }
}

// ---------- 分页访问 ----------
/** 页缓存 LRU 写入（上限 2 本，防大书占内存）；ensurePages / loadOrComputeStarts 共用 */
function cachePutPageStarts(key, starts) {
  if (pageCache.size >= 2) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(key, starts);
}

/** 分页三级策略：内存 LRU（2 本）→ 现算并落盘 IndexedDB（键 bookId|size，大书重开免重算） */
function ensurePages(bookId, text, size) {
  const key = bookId + '|' + size;
  let starts = pageCache.get(key);
  if (starts) {
    pageCache.delete(key);
    pageCache.set(key, starts); // 触达，保持 LRU 语义
    return starts;
  }
  starts = Uint32Array.from(computePageStarts(text, size));
  cachePutPageStarts(key, starts);
  void putPageStarts(key, starts).catch(() => {});
  return starts;
}

/** 打开书时预热：优先读 IndexedDB 里已持久化的分页（校验首尾与全文长度一致才可信），无效再现算 */
async function loadOrComputeStarts(bookId, text, size) {
  const key = bookId + '|' + size;
  const cached = pageCache.get(key);
  if (cached) {
    pageCache.delete(key);
    pageCache.set(key, cached);
    return cached;
  }
  let stored = null;
  try { stored = await getPageStarts(key); } catch (e) { /* 忽略 */ }
  if (stored && stored.length > 1 && stored[0] === 0 && stored[stored.length - 1] === text.length) {
    cachePutPageStarts(key, stored);
    return stored;
  }
  const starts = Uint32Array.from(computePageStarts(text, size));
  cachePutPageStarts(key, starts);
  void putPageStarts(key, starts).catch(() => {});
  return starts;
}

/** 章节起始预热：IndexedDB 命中或现算（现算后落盘；删书/更新书时清理） */
async function loadOrComputeChapters(bookId, text) {
  let stored = null;
  try { stored = await getChapters(bookId); } catch (e) { /* 忽略 */ }
  if (Array.isArray(stored) && stored.length > 0 && typeof stored[0] === 'number' && stored[stored.length - 1] < text.length) {
    chapterStarts = stored;
    return;
  }
  const starts = parseChapterStarts(text);
  chapterStarts = starts;
  if (starts.length) void putChapters(bookId, starts).catch(() => {});
}

function currentPages() {
  if (!currentBookId || !readingText) return null;
  return ensurePages(currentBookId, readingText, settings.pageSize);
}

// ---------- 标题 ----------
/** 标题 = 组基准页 + 自己的行序（myRank）；伪装态显示伪装标题 */
function applyTitle() {
  if (disguised) {
    document.title = settings.disguiseTitle || DEFAULT_SETTINGS.disguiseTitle;
    return;
  }
  const starts = currentPages();
  if (!starts) {
    document.title = NEUTRAL_TITLE;
    return;
  }
  const total = Math.max(1, starts.length - 1);
  const baseIdx = Math.min(findPageIndex(starts, charIndex), total - 1);
  const idx = Math.min(baseIdx + (myRank || 0), total - 1);
  const slice = readingText.slice(starts[idx], starts[idx + 1] !== undefined ? starts[idx + 1] : readingText.length);
  let t = pageToTitle(slice);
  if (settings.prefixEnabled && settings.prefixText) t = settings.prefixText + t;
  document.title = t;
}

// ---------- 翻页（联动：移动组基准并广播给其他成员） ----------
/** 采纳组内最新基准（session.base，按书隔离）；返回是否采纳 */
async function adoptGroupBase() {
  try {
    const d = await chrome.storage.session.get('base');
    const base = d && d.base;
    if (base && base.bookId === currentBookId && typeof base.charIndex === 'number') {
      charIndex = base.charIndex;
      return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

/** 翻页步长：逐行模式固定 1 行；整页模式 = 联动组当前行数（3 个速记页一次翻过整个三行窗口） */
async function groupStep() {
  if (settings.flipMode === 'line') return 1;
  if (!isMember) return 1;
  const alive = await listAliveMembers();
  return Math.max(1, Math.min(alive.length, MAX_TABS));
}

/** 下一页（联动：移动组基准并广播给其他成员）。
 *  返回值是「本页是否处理了请求」：true = 已翻页 / 幂等对齐 / 到边界（提示）；
 *  false = 书架态 / 伪装态 / 无书等不可执行。background 的转发链只认 true，
 *  避免停在书架态的成员以 ok 吞掉请求、后续能翻页的成员收不到消息。 */
async function nextPage(fromCharIndex) {
  const starts = currentPages();
  if (!starts || disguised) return false;
  // 组基准可能已被其他成员推进（冻结页解冻后收到的排队翻页）：以最新基准为准，已推进则不重复翻
  await adoptGroupBase();
  if (typeof fromCharIndex === 'number' && charIndex !== fromCharIndex) {
    await renderPage(); // 幂等对齐：组已推进，本页对齐显示即可
    return true;
  }
  const step = await groupStep();
  const total = Math.max(1, starts.length - 1);
  const baseIdx = Math.min(findPageIndex(starts, charIndex), total - 1);
  if (baseIdx >= total - 1) {
    showNotice('已经是最后一页');
    return true; // 到边界：请求已被处理（提示），无需其他成员重复尝试
  }
  charIndex = starts[Math.min(baseIdx + step, total - 1)];
  await renderPage();
  broadcastSync();
  scheduleSaveProgress();
  return true;
}

async function prevPage(fromCharIndex) {
  const starts = currentPages();
  if (!starts || disguised) return false;
  await adoptGroupBase();
  if (typeof fromCharIndex === 'number' && charIndex !== fromCharIndex) {
    await renderPage();
    return true;
  }
  const step = await groupStep();
  const baseIdx = findPageIndex(starts, charIndex);
  if (baseIdx <= 0) {
    showNotice('已经是第一页');
    return true;
  }
  charIndex = starts[Math.max(baseIdx - step, 0)];
  await renderPage();
  broadcastSync();
  scheduleSaveProgress();
  return true;
}

/** 渲染本页：组基准 + 自己在标签栏中的序号 → 本页显示的页 */
async function renderPage() {
  const starts = currentPages();
  const meta = books.find((b) => b.id === currentBookId);
  if (!starts || !meta) {
    showView('shelf');
    return;
  }
  const total = Math.max(1, starts.length - 1);
  const baseIdx = Math.min(findPageIndex(starts, charIndex), total - 1);
  charIndex = starts[baseIdx]; // 对齐到页首，保证位置稳定
  if (isMember) {
    try {
      const alive = await listAliveMembers();
      const r = alive.findIndex((m) => m.token === myToken);
      myRank = r >= 0 ? r : 0;
      groupSize = Math.max(1, Math.min(alive.length, MAX_TABS));
    } catch (e) { myRank = 0; }
  }
  const myIdx = Math.min(baseIdx + myRank, total - 1);
  applyTitle();
  renderPageText();
  $('#read-book-name').textContent = meta.title;  $('#page-indicator').textContent = `第 ${myIdx + 1} / ${total} 页`;
  const pct = meta.totalChars > 0 ? Math.floor((charIndex / meta.totalChars) * 100) : 0;
  let progressText = `进度 ${pct}%`;
  if (chapterStarts && chapterStarts.length) {
    progressText += ` · 第 ${chapterOfPageIndex(starts, chapterStarts, baseIdx, readingText.length) + 1}/${chapterStarts.length} 章`;
  }
  $('#read-progress').textContent = progressText;
  applyFavicon(); // 行序变化（重排/开关标签）时图标跟随对应槽位
  scheduleSaveProgress();
}

// ---------- 伪装（老板键 / Esc） ----------
function setDisguiseUi(on) {
  for (const id of ['search-input', 'search-prev', 'search-next', 'prev-btn', 'next-btn', 'toc-btn']) {
    const el = $('#' + id);
    if (el) el.disabled = on;
  }
}

// ---------- 标签页图标（favicon） ----------
const DEFAULT_FAVICON = 'icons/icon128.png';

/** 补全协议并校验网址：仅接受 http(s)（图标以网址引用，杜绝 javascript: 等协议进入 href） */
function normalizeIconUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const h = new URL(u).href;
    return /^https?:/i.test(h) ? h : '';
  } catch (e) { return ''; }
}

/** 当前槽位的图标地址（rank 0/1/2 对应第 1/2/3 个标签位）；伪装态强制默认中性图标；
 *  仅接受 http(s) 网址与图片 dataURL，其余（含被写坏的值）一律回默认，防止怪协议进入 href */
function slotFaviconHref() {
  if (disguised) return DEFAULT_FAVICON;
  const slots = Array.isArray(settings.slotFavicons) ? settings.slotFavicons : [];
  const v = String(slots[Math.min(myRank, MAX_TABS - 1)] || '');
  return (/^https?:\//i.test(v) || /^data:image\//i.test(v)) ? v : DEFAULT_FAVICON;
}

/** 应用当前标签位图标；网址图标加载失败自动尝试站点 /favicon.ico（带防缓存参数），再失败回默认 */
function applyFavicon() {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  const href = slotFaviconHref();
  if (link.getAttribute('href') === href) return; // 未变化不重复加载

  const restoreDefault = () => {
    link.onerror = null;
    if (!link.getAttribute('href').endsWith(DEFAULT_FAVICON)) {
      link.setAttribute('href', DEFAULT_FAVICON);
      showNotice('自定义图标加载失败，已恢复默认');
    }
  };
  // 第一次失败：换站点 /favicon.ico 兜底（踩坑 15：favicon.ico 有 HTTP 缓存，须带防缓存参数），
  // 并为兜底 URL 重挂 onerror——每次 setAttribute('href') 都是一次全新加载，都需要自己的失败处理器
  link.onerror = () => {
    link.onerror = null;
    if (/^https?:/i.test(href) && !/\/favicon\.ico(\?|$)/i.test(href)) {
      try {
        const bustUrl = new URL(href).origin + '/favicon.ico?_tnr=' + Date.now();
        link.setAttribute('href', bustUrl);
        link.onerror = restoreDefault; // 关键：接住第二跳失败，链路不再断裂
        return;
      } catch (e) { /* URL 解析失败：落入恢复默认 */ }
    }
    restoreDefault();
  };
  link.setAttribute('href', href);
}

/** 切换伪装（纯本地，不广播）。返回是否真的切换了（被防抖/同态拒绝时为 false）。
 *  消息处理器（toggle-title-mask）必须走本函数：若走 toggleDisguise 会再次广播，
 *  组内成员互相触发形成回声——靠 200ms 防抖兜底，迟到的解冻消息（>200ms）会造成组状态分裂 */
function setDisguise(next) {
  if (next === disguised) return false;
  const now = Date.now();
  if (now - lastToggleAt < 200) return false; // 防抖：避免命令转发与页面事件叠加
  lastToggleAt = now;
  disguised = next;
  applyTitle();
  applyFavicon();
  document.body.classList.toggle('disguised', disguised);
  const hint = $('#disguise-hint');
  if (hint) hint.hidden = !disguised;
  setDisguiseUi(disguised);
  if (disguised) {
    // 伪装瞬间失焦：visibility:hidden 不打断已有焦点，焦点残留在隐藏按钮上时
    // Enter/Space 仍会激活（如删除按钮弹 window.confirm 系统对话框击穿伪装面）
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') {
      try { active.blur(); } catch (e) { /* 忽略 */ }
    }
    if ($('#toc-view') && !$('#toc-view').hidden) showView('read'); // 目录页含标题与正文片段：伪装时一并收起
  }
  return true;
}

/** 用户主动切换（Esc / 老板键）：本地切换成功后广播全组一起伪装 */
function toggleDisguise() {
  if (setDisguise(!disguised)) broadcastRaw({ type: 'toggle-title-mask' });
}

// ---------- 搜索与正文显示 ----------
let searchState = { query: '', matches: [], current: -1, truncated: false };
let searchTimer = null;

function clearSearch() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  searchState = { query: '', matches: [], current: -1, truncated: false };
  const input = $('#search-input');
  if (input) input.value = '';
  updateSearchCount();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateSearchCount() {
  const el = $('#search-count');
  if (!el) return;
  const s = searchState;
  el.textContent = !s.query ? '' : (s.matches.length ? `${s.current + 1}/${s.matches.length}${s.truncated ? '+' : ''}` : '无结果');
}

/** 执行搜索：收集全部匹配（封顶 MAX_SEARCH_MATCHES），定位到当前页之后的第一个并跳转 */
function runSearch() {
  // 防抖回调可能晚于视图切换/伪装/删书：此时丢弃，避免跳进度与穿透伪装冻结
  if (disguised || $('#read-view').hidden || !currentBookId) return;
  const q = $('#search-input').value;
  searchState = { query: q, matches: [], current: -1, truncated: false };
  if (!q || !readingText) {
    updateSearchCount();
    renderPageText();
    return;
  }
  const { matches, truncated } = collectMatches(readingText, q, MAX_SEARCH_MATCHES);
  searchState.matches = matches;
  searchState.truncated = truncated; // 截断时计数以「+」提示，跳转在前 cap 个匹配内循环
  if (searchState.matches.length) {
    searchState.current = searchState.matches.findIndex((p) => p >= charIndex);
    if (searchState.current < 0) searchState.current = 0;
    charIndex = searchState.matches[searchState.current];
    renderPage(); // 对齐页首 + 标题同步跳转 + 正文高亮
    broadcastSync();
  }
  updateSearchCount();
  renderPageText();
}

/** 在匹配间循环跳转（delta = ±1） */
function jumpToMatch(delta) {
  const s = searchState;
  if (!s.matches.length) return;
  s.current = (s.current + delta + s.matches.length) % s.matches.length;
  charIndex = s.matches[s.current];
  renderPage();
  updateSearchCount();
  broadcastSync();
}

/** 正文区：显示整组当前屏（基准行起的连续行块，第 2 行起两空格缩进），搜索匹配高亮 */
function renderPageText() {
  const el = $('#page-text');
  if (!el) return;
  el.textContent = '';
  const starts = currentPages();
  if (!starts || settings.showPageText === false) return;
  const total = Math.max(1, starts.length - 1);
  const baseIdx = Math.min(findPageIndex(starts, charIndex), total - 1);
  const lines = Math.max(1, Math.min(groupSize, MAX_TABS));
  const qLen = searchState.query ? searchState.query.length : 0;
  for (let r = 0; r < lines; r++) {
    const idx = Math.min(baseIdx + r, total - 1);
    const a = starts[idx];
    const b = starts[idx + 1] !== undefined ? starts[idx + 1] : readingText.length;
    if (r > 0) el.append(document.createTextNode('\n  '));
    let pos = a;
    for (let i = 0; i < searchState.matches.length; i++) {
      const p = searchState.matches[i];
      if (p >= b || p + qLen <= a) continue; // 与本行无交集
      const s = Math.max(p, a);
      const e = Math.min(p + qLen, b);
      if (s > pos) el.append(document.createTextNode(readingText.slice(pos, s)));
      const mark = document.createElement('mark');
      if (i === searchState.current) mark.className = 'cur';
      mark.textContent = readingText.slice(s, e);
      el.append(mark);
      pos = Math.max(pos, e);
    }
    if (pos < b) el.append(document.createTextNode(readingText.slice(pos, b)));
    if (idx >= total - 1) break; // 到达最后一页：后续行不再重复
  }
}

function bindSearch() {
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimer) { // 有未落地的防抖搜索：先立即执行，避免用过期 matches 跳转
        clearTimeout(searchTimer);
        searchTimer = null;
        runSearch();
        return;
      }
      jumpToMatch(e.shiftKey ? -1 : 1);
    }
  });
  $('#search-prev').addEventListener('click', () => jumpToMatch(-1));
  $('#search-next').addEventListener('click', () => jumpToMatch(1));
}

// ---------- 目录（章节跳转） ----------
function bindToc() {
  $('#toc-btn').addEventListener('click', () => {
    if (!currentBookId || !readingText) return;
    showView('toc');
    renderToc();
  });
  $('#toc-back').addEventListener('click', () => {
    if (currentBookId) {
      showView('read');
      renderPage();
    } else {
      showView('shelf');
      renderShelf();
    }
  });
}

/** 渲染目录：章节标题行 + 所在页码（双指针求章首页），当前章高亮并滚到可见 */
function renderToc() {
  const listEl = $('#toc-list');
  listEl.textContent = '';
  const starts = currentPages();
  const cs = chapterStarts;
  const ok = !!(cs && cs.length && starts);
  $('#toc-empty').hidden = ok;
  $('#toc-count').textContent = ok ? `${cs.length} 章` : '';
  if (!ok) return;
  const cur = chapterOfPageIndex(starts, cs, findPageIndex(starts, charIndex), readingText.length);
  let p = 0;
  for (let i = 0; i < cs.length; i++) {
    while (p < starts.length - 2 && starts[p + 1] <= cs[i]) p++;
    const li = document.createElement('li');
    if (i === cur) li.className = 'current';
    let title = readingText.slice(cs[i], Math.min(readingText.length, cs[i] + 64)).split('\n')[0].trim();
    if (!title) title = `第 ${i + 1} 章`;
    if (title.length > 40) title = title.slice(0, 40) + '…';
    const name = document.createElement('span');
    name.className = 'toc-name';
    name.textContent = title;
    const page = document.createElement('span');
    page.className = 'toc-page';
    page.textContent = `P${p + 1}`;
    li.append(name, page);
    li.addEventListener('click', () => jumpToChapter(i));
    listEl.append(li);
  }
  const curEl = listEl.children[cur];
  if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'center' });
}

function jumpToChapter(i) {
  // 越界检查代替 truthy 检查：第 1 章起点为 0（文件首行即标题）是合法值，!0 === true 会误拦
  if (!chapterStarts || i < 0 || i >= chapterStarts.length) return;
  charIndex = chapterStarts[i];
  showView('read');
  renderPage();
  broadcastSync();
  scheduleSaveProgress();
}

// ---------- 视图 ----------
function showView(name) {
  for (const v of ['shelf', 'read', 'settings', 'toc']) {
    const el = $('#' + v + '-view');
    if (el) el.hidden = v !== name;
  }
}

// ---------- 书架 ----------
function renderShelf() {
  const list = $('#book-list');
  list.textContent = '';
  $('#shelf-empty').hidden = books.length > 0;
  for (const b of books) {
    const li = document.createElement('li');
    li.className = 'book-item' + (b.id === currentBookId ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'book-info';
    const name = document.createElement('div');
    name.className = 'book-title';
    name.textContent = b.title;
    const sub = document.createElement('div');
    sub.className = 'book-sub';
    const pct = b.totalChars > 0 ? Math.floor(((b.charIndex || 0) / b.totalChars) * 100) : 0;
    sub.textContent = `进度 ${pct}% · ${(b.totalChars / 10000).toFixed(1)} 万字符`;
    info.append(name, sub);
    const readBtn = document.createElement('button');
    readBtn.className = 'btn btn-primary';
    readBtn.textContent = '打开';
    readBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBook(b.id);
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBook(b.id);
    });
    li.append(info, readBtn, delBtn);
    li.addEventListener('click', () => openBook(b.id));
    list.append(li);
  }
}

async function openBook(id, opts = {}) {
  const meta = books.find((b) => b.id === id);
  if (!meta) {
    showNotice('条目不存在');
    return;
  }
  let text;
  try {
    text = await getBookText(id);
  } catch (e) {
    showNotice('读取内容失败');
    return;
  }
  if (typeof text !== 'string' || text.length === 0) {
    showNotice('内容数据缺失，请删除后重新导入');
    return;
  }
  currentBookId = id;
  readingText = text;
  charIndex = opts.charIndex !== undefined
    ? Math.min(Math.max(0, opts.charIndex), text.length - 1)
    : Math.min(Math.max(0, meta.charIndex || 0), text.length - 1);
  chapterStarts = null;
  await loadOrComputeStarts(id, text, settings.pageSize); // 大书命中持久化分页则免重算
  await loadOrComputeChapters(id, text);
  disguised = false;
  document.body.classList.remove('disguised');
  const hint = $('#disguise-hint');
  if (hint) hint.hidden = true;
  setDisguiseUi(false);
  clearSearch();
  showView('read');
  await renderPage();
  flushProgress();
  if (!opts.silent) broadcastSync();
}

async function removeBook(id) {
  const meta = books.find((b) => b.id === id);
  if (!meta) return;
  if (!window.confirm(`删除「${meta.title}」？内容与进度将一并清除。`)) return;
  await mergeBooksWrite((list) => list.filter((b) => b.id !== id));
  invalidateBookCaches(id);
  try { await deleteBookText(id); } catch (e) { /* 忽略 */ }
  if (currentBookId === id) {
    currentBookId = null;
    readingText = '';
    charIndex = 0;
    chapterStarts = null;
    disguised = false;
    document.body.classList.remove('disguised');
    document.title = NEUTRAL_TITLE;
    showView('shelf');
  }
  try { await chrome.storage.local.set({ currentBookId }); } catch (e) { /* 忽略 */ }
  renderShelf();
  showNotice('已删除');
  broadcastSync(); // bookId 为 null 时其他成员回到书架
}

/** 使某本书的分页/章节缓存（内存 + IndexedDB）失效；删书或源文件更新时调用。
 *  返回 IndexedDB 清理完成的 promise：更新书后需 await，否则随后的预热可能读到旧记录。 */
function invalidateBookCaches(bookId) {
  for (const k of [...pageCache.keys()]) {
    if (k.startsWith(bookId + '|')) pageCache.delete(k);
  }
  if (bookId === currentBookId) chapterStarts = null;
  return (async () => {
    try { await deletePageStartsForBook(bookId); } catch (e) { /* 忽略 */ }
    try { await deleteChapters(bookId); } catch (e) { /* 忽略 */ }
  })();
}

// ---------- 设置 ----------
function openSettings() {
  settingsReturn = $('#read-view').hidden ? 'shelf' : 'read';
  $('#set-page-size').value = String(settings.pageSize);
  $('#set-flip-mode').value = settings.flipMode;
  $('#set-encoding').value = settings.encoding;
  $('#set-disguise-title').value = settings.disguiseTitle;
  $('#set-prefix-enabled').checked = !!settings.prefixEnabled;
  $('#set-prefix-text').value = settings.prefixText || '';
  $('#set-show-page-text').checked = settings.showPageText !== false;
  $('#set-key-prev').dataset.code = settings.keyPrev;
  $('#set-key-prev').value = settings.keyPrev;
  $('#set-key-next').dataset.code = settings.keyNext;
  $('#set-key-next').value = settings.keyNext;
  $('#set-key-boss').value = settings.bossKey || '';
  $('#set-key-boss').dataset.code = settings.bossKey || '';
  refreshFaviconSlots();
  $('#prefix-text-row').hidden = !settings.prefixEnabled;
  showView('settings');
}

/** 录键输入框：点击聚焦后按任意键录制（Esc 取消，纯修饰键忽略）；apply 收到完整键盘事件，
 *  返回 true 用 e.code 作显示，返回字符串则用其作显示（老板键需显示完整组合键） */
function bindKeyCapture(input, apply) {
  const show = () => {
    input.value = input.dataset.code || '';
    input.classList.remove('capturing');
  };
  input.addEventListener('focus', () => {
    input.classList.add('capturing');
    input.value = '按下任意键录制（Esc 取消）';
  });
  input.addEventListener('blur', show);
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { input.blur(); return; }
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return; // 忽略纯修饰键
    const r = apply(e);
    if (r) {
      input.dataset.code = typeof r === 'string' ? r : e.code;
      input.blur();
    }
  });
}

function bindSettings() {
  $('#open-settings-shelf').addEventListener('click', openSettings);
  $('#open-settings-read').addEventListener('click', openSettings);
  $('#settings-back').addEventListener('click', () => {
    if (settingsReturn === 'read' && currentBookId) {
      showView('read');
      renderPage();
    } else {
      showView('shelf');
      renderShelf();
    }
  });
  $('#set-page-size').addEventListener('change', async () => {
    const v = clampPageSize($('#set-page-size').value);
    $('#set-page-size').value = String(v);
    if (v !== settings.pageSize) {
      settings.pageSize = v;
      saveSettings();
      pageCache.clear();
      try { await clearAllPageStarts(); } catch (e) { /* 清理失败不影响功能，删书时仍会按书清理 */ }
      if (currentBookId && readingText) {
        await loadOrComputeStarts(currentBookId, readingText, v); // 新页大小的分页立即可用（必要时落盘）
        renderPage(); // charIndex 不变 → 阅读位置保留
      }
    }
  });
  $('#set-flip-mode').addEventListener('change', () => {
    settings.flipMode = $('#set-flip-mode').value === 'line' ? 'line' : 'block';
    saveSettings(); // 广播 sync，其他成员即时生效
    showNotice(settings.flipMode === 'line' ? '已切换为逐行翻页' : '已切换为整体翻页');
  });
  $('#set-encoding').addEventListener('change', () => {
    settings.encoding = $('#set-encoding').value;
    saveSettings();
    showNotice('编码设置将应用于之后导入的文件');
  });
  $('#set-disguise-title').addEventListener('change', () => {
    const v = $('#set-disguise-title').value.trim();
    settings.disguiseTitle = v || DEFAULT_SETTINGS.disguiseTitle;
    $('#set-disguise-title').value = settings.disguiseTitle;
    saveSettings();
    applyTitle();
  });
  $('#set-prefix-enabled').addEventListener('change', () => {
    settings.prefixEnabled = $('#set-prefix-enabled').checked;
    $('#prefix-text-row').hidden = !settings.prefixEnabled;
    saveSettings();
    applyTitle();
    if (settings.prefixEnabled && !settings.prefixText) showNotice('前缀文案为空，前缀伪装暂不生效');
  });
  $('#set-prefix-text').addEventListener('change', () => {
    settings.prefixText = $('#set-prefix-text').value;
    saveSettings();
    applyTitle();
  });
  $('#set-show-page-text').addEventListener('change', () => {
    settings.showPageText = $('#set-show-page-text').checked;
    saveSettings();
    renderPageText();
  });
  bindKeyCapture($('#set-key-prev'), (e) => {
    const code = e.code;
    if (code === settings.keyNext) {
      showNotice('上一页与下一页不能绑定同一个按键');
      return false;
    }
    if (bossKeyConflictsFlip(settings.bossKey, code)) {
      showNotice('该键已被老板键占用，请给老板键加修饰键或换键');
      return false;
    }
    settings.keyPrev = code;
    saveSettings();
    showNotice('上一页按键已设为 ' + code + '（网页端即时生效）');
    return true;
  });
  bindKeyCapture($('#set-key-next'), (e) => {
    const code = e.code;
    if (code === settings.keyPrev) {
      showNotice('上一页与下一页不能绑定同一个按键');
      return false;
    }
    if (bossKeyConflictsFlip(settings.bossKey, code)) {
      showNotice('该键已被老板键占用，请给老板键加修饰键或换键');
      return false;
    }
    settings.keyNext = code;
    saveSettings();
    showNotice('下一页按键已设为 ' + code + '（网页端即时生效）');
    return true;
  });
  bindKeyCapture($('#set-key-boss'), (e) => {
    const spec = formatBossKey(e);
    if (bossKeyConflictsFlip(spec, settings.keyPrev) || bossKeyConflictsFlip(spec, settings.keyNext)) {
      showNotice('老板键不能与翻页键相同（翻页键不支持组合键，请给老板键加修饰键）');
      return false;
    }
    settings.bossKey = spec;
    saveSettings();
    showNotice('老板键已设为 ' + spec + '（网页端即时生效；chrome:// 内部页不生效）');
    return spec; // 录制框显示完整组合键
  });
  $('#keys-reset').addEventListener('click', () => {
    settings.keyPrev = DEFAULT_SETTINGS.keyPrev;
    settings.keyNext = DEFAULT_SETTINGS.keyNext;
    saveSettings();
    $('#set-key-prev').dataset.code = settings.keyPrev;
    $('#set-key-prev').value = settings.keyPrev;
    $('#set-key-next').dataset.code = settings.keyNext;
    $('#set-key-next').value = settings.keyNext;
    showNotice('已恢复默认翻页键（4 / 6）');
  });
  $('#boss-reset').addEventListener('click', () => {
    settings.bossKey = DEFAULT_SETTINGS.bossKey;
    saveSettings();
    $('#set-key-boss').value = settings.bossKey;
    $('#set-key-boss').dataset.code = settings.bossKey;
    showNotice('已恢复默认老板键（Alt+Q）');
  });
  buildFaviconSlots();
}

/** 生成三个标签位的图标设置控件（上传 / 网址 + 获取 / 清除），按行序绑定 */
function buildFaviconSlots() {
  const container = $('#favicon-slots');
  if (!container) return;
  container.textContent = '';
  for (let i = 0; i < MAX_TABS; i++) {
    const row = document.createElement('div');
    row.className = 'favicon-slot';
    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = `第 ${i + 1} 个标签`;
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.className = 'btn';
    upload.textContent = '上传';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    file.dataset.slot = String(i);
    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'favicon-url';
    url.placeholder = '或输入图标/网站网址';
    url.dataset.slot = String(i);
    const get = document.createElement('button');
    get.type = 'button';
    get.className = 'btn';
    get.textContent = '获取';
    get.dataset.act = 'get';
    get.dataset.slot = String(i);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn';
    clear.textContent = '清除';
    clear.dataset.act = 'clear';
    clear.dataset.slot = String(i);
    row.append(label, upload, file, url, get, clear);
    container.append(row);

    upload.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { showNotice('请选择图片文件'); return; }
      if (f.size > 2 * 1024 * 1024) { showNotice('图片请小于 2MB'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        settings.slotFavicons[i] = String(fr.result || '');
        saveSettings();
        applyFavicon();
        showNotice(`第 ${i + 1} 个标签图标已更新（伪装时会自动回默认图标）`);
      };
      fr.onerror = () => showNotice('图片读取失败');
      fr.readAsDataURL(f);
    });
    get.addEventListener('click', () => fetchFaviconFor(i));
    clear.addEventListener('click', () => {
      settings.slotFavicons[i] = '';
      url.value = '';
      saveSettings();
      applyFavicon();
      showNotice(`第 ${i + 1} 个标签图标已恢复默认`);
    });
  }
  refreshFaviconSlots();
}

/** 把当前槽位值回填到设置控件 */
function refreshFaviconSlots() {
  for (let i = 0; i < MAX_TABS; i++) {
    const url = $(`#favicon-slots .favicon-url[data-slot="${i}"]`);
    if (url) url.value = /^data:/.test(settings.slotFavicons[i] || '') ? '（已上传图片）' : (settings.slotFavicons[i] || '');
  }
}

/** 探测网址能否加载为有效图片（不受 CORS 限制，纯本地判定） */
function probeImage(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** 「获取」：按 用户网址 → 站点 /favicon.ico 逐个尝试（带防缓存参数，拿到的是最新的），成功写入槽位 */
async function fetchFaviconFor(slotIdx) {
  const urlInput = $(`#favicon-slots .favicon-url[data-slot="${slotIdx}"]`);
  const u = normalizeIconUrl(urlInput ? urlInput.value : '');
  if (!u) {
    showNotice('请先输入图标或网站网址');
    return;
  }
  showNotice('正在获取图标…');
  const bust = (x) => x + (x.includes('?') ? '&' : '?') + '_tnr=' + Date.now();
  const candidates = [bust(u)];
  try { candidates.push(bust(new URL(u).origin + '/favicon.ico')); } catch (e) { /* 忽略 */ }
  for (const c of candidates) {
    if (await probeImage(c, 5000)) {
      settings.slotFavicons[slotIdx] = c;
      await saveSettings();
      refreshFaviconSlots();
      applyFavicon();
      showNotice(`第 ${slotIdx + 1} 个标签图标获取成功`);
      return;
    }
  }
  showNotice('未能获取到有效图标，请检查网址');
}

// ---------- 键盘（capture 阶段；输入类元素不拦截） ----------
function isEditable(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (window.__tnrYielded) return; // 本页已让位、即将关闭
    const k = e.key;
    const boss = matchBossKey(e, parseBossKey(settings.bossKey));
    // 翻页键可自定义（settings.keyPrev/keyNext；DigitN 与 NumpadN 自动互通）；Esc 与老板键切换伪装
    const isPrev = expandKeyCodes(settings.keyPrev).has(e.code);
    const isNext = expandKeyCodes(settings.keyNext).has(e.code);
    if (!isPrev && !isNext && !boss && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Escape') return;
    if (isEditable(e.target)) return;                // 输入框内不拦截
    if (!boss && (e.ctrlKey || e.metaKey || e.altKey)) return;  // 组合键不劫持（老板键自带修饰键，豁免）
    e.preventDefault();
    // 自定义键分支优先：NumLock 关闭时小键盘数字的 e.key 是方向键，需互斥防双触发
    if (isPrev) prevPage();
    else if (isNext) nextPage();
    else if (boss) toggleDisguise();
    else if (k === 'ArrowRight') nextPage();
    else if (k === 'ArrowLeft') prevPage();
    else toggleDisguise();
  }, true);
}

// ---------- 导入交互 ----------
function bindImport() {
  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', () => {
    importFiles($('#file-input').files);
    $('#file-input').value = '';
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      importFiles(e.dataTransfer.files);
    }
  });
}

function bindReadView() {
  $('#back-to-shelf').addEventListener('click', () => {
    showView('shelf');
    renderShelf();
  });
  $('#prev-btn').addEventListener('click', prevPage);
  $('#next-btn').addEventListener('click', nextPage);
}

// ---------- background 消息（老板键 / 翻页转发 / 组同步 / 探测） ----------
function bindMessages() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.type === 'toggle-title-mask') {
      // 他页转发来的伪装切换：只本地切换，不再广播（toggleDisguise 会回声广播，
      // 组内成员互相触发依赖防抖兜底，迟到的解冻消息会分裂组状态）
      setDisguise(!disguised);
      sendResponse({ ok: true, token: myToken });
    } else if (msg.type === 'page-next') {
      // 等 nextPage 真正执行完再应答：ok 与「是否处理了请求」一致（书架态/伪装态回 false），
      // background 转发链据此继续尝试下一个成员，不再被不可执行的成员拦截
      (async () => { sendResponse({ ok: await nextPage(msg.fromCharIndex), token: myToken }); })();
    } else if (msg.type === 'page-prev') {
      (async () => { sendResponse({ ok: await prevPage(msg.fromCharIndex), token: myToken }); })();
    } else if (msg.type === 'reader-ping') {
      sendResponse({ ok: true, token: myToken });
    } else if (msg.type === 'sync') {
      // 其他成员的进度/书/设置变化：重读状态并按自己的槽位重渲染（不再二次广播）
      (async () => {
        try {
          if (typeof msg.charIndex === 'number') charIndex = msg.charIndex;
          if (msg.bookId === null) {
            currentBookId = null;
            readingText = '';
            searchState = { query: '', matches: [], current: -1 };
            document.title = NEUTRAL_TITLE;
            showView('shelf');
            renderShelf();
            sendResponse({ ok: true });
            return;
          }
          if (msg.bookId && msg.bookId !== currentBookId) {
            await openBook(msg.bookId, { silent: true, charIndex: msg.charIndex });
            sendResponse({ ok: true });
            return;
          }
          await loadState(); // 同步设置（页大小/键位/图标等）与最新书目
          renderShelf();     // 其他页可能刚导入/更新/删除了条目，书架即时反映
          await renderPage();
          applyFavicon();
          sendResponse({ ok: true });
        } catch (e) {
          try { sendResponse({ ok: false }); } catch (e2) { /* 忽略 */ }
        }
      })();
      return true; // 异步应答
    }
    return undefined;
  });
}

// ---------- 开发热重载（仅 unpacked 开发安装生效） ----------
/** 轮询扩展自身文件（同源 fetch，无任何外部请求）的哈希：变更即 chrome.runtime.reload()，本页随后自刷新。
 *  商店安装（installType !== 'development'）完全不启用。扩展重载后旧页面的 chrome.* 已失效，
 *  但页面 JS 仍在：下一轮轮询拿到新内容与旧基线不符 → 自刷新，由新扩展重新接手。 */
function setupDevHotReload() {
  const FILES = ['manifest.json', 'reader.js', 'reader.html', 'reader.css', 'content.js', 'background.js', 'epub.js'];
  let baseline = null;
  setInterval(async () => {
    let h = '';
    try {
      const texts = await Promise.all(FILES.map((f) => fetch(chrome.runtime.getURL(f), { cache: 'no-store' }).then((r) => r.text())));
      const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\u0000')));
      h = Array.from(new Uint8Array(digestBuf), (x) => x.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return; // 扩展正在重载：下一轮拿到新内容后会自刷新
    }
    if (baseline === null) { baseline = h; return; }
    if (h !== baseline) {
      try { chrome.runtime.reload(); } catch (e) { /* 上下文已失效：跳过，直接自刷新 */ }
      setTimeout(() => location.reload(), 400);
    }
  }, 1500);
}

// ---------- 生命周期 ----------
function bindLifecycle() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushProgress();
  });
  window.addEventListener('pagehide', () => {
    flushProgress(true); // 关页单跳直写，不再做异步校验
    leaveGroup();
  });
  window.addEventListener('beforeunload', () => {
    flushProgress(true);
  });
  // bfcache 恢复后 pagehide 已离开过组：重新加入，否则老板键失效且进度停写
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    groupLostNotified = false;
    joinGroup().then((ok) => {
      if (ok && currentBookId) renderPage();
      if (ok) broadcastRaw({ type: 'sync' }); // 重入组：既有成员按新行数/行序重渲染
    });
  });
}

// ---------- 启动 ----------
async function boot() {
  // 依赖兜底：epub.js / keys.js 任一缺失（磁盘损坏/被策略拦截等极端场景）时显式报错，
  // 避免导入、翻页、老板键全部静默半瘫无从排查（MV3 CSP 禁内联脚本，探测只能放本文件）
  if (typeof parseEpub !== 'function' || typeof matchBossKey !== 'function' || typeof expandKeyCodes !== 'function') {
    document.title = NEUTRAL_TITLE;
    showNotice('Thief Tab 脚本加载不完整，请重新安装扩展', 8000);
    return;
  }
  bindMessages();
  bindKeyboard();
  bindImport();
  bindReadView();
  bindSearch();
  bindToc();
  bindSettings();
  bindLifecycle();
  try {
    const self = await chrome.management.getSelf(); // 无需 management 权限
    if (self && self.installType === 'development') setupDevHotReload();
  } catch (e) { /* 非扩展环境或无 management：跳过 */ }
  document.title = NEUTRAL_TITLE;
  const ok = await joinGroup();
  if (!ok) { // 满员（已有 3 个速记页）：提示后自动关闭，不初始化
    window.__tnrYielded = true;
    bootReadyResolve();
    return;
  }
  await loadState();
  renderShelf();
  broadcastRaw({ type: 'sync' }); // 新成员入组：既有成员按新行数/行序重渲染（正文区整组行块随行数变化）
  if (currentBookId && books.some((b) => b.id === currentBookId)) {
    await openBook(currentBookId); // F12：自动恢复上次的书和页码
  } else {
    currentBookId = null;
    showView('shelf');
  }
  bootDone = true;
  window.__tnrBooted = true;
  bootReadyResolve();
  applyFavicon();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  boot();
}

// Node 单测导出（浏览器环境没有 module，忽略）。
// parseBossKey / matchBossKey / formatBossKey / bossKeyConflictsFlip / expandKeyCodes
// 在 keys.js，单测需另行 require（engine.test.cjs 已合并两个模块）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeText,
    countValidChars,
    detectAndDecode,
    computePageStarts,
    findPageIndex,
    pageToTitle,
    collectMatches,
    parseChapterStarts,
    findChapterIndex,
    BREAK_CHARS,
    DEFAULT_SETTINGS,
    MAX_FILE_BYTES,
    MIN_VALID_CHARS,
    PAGE_SIZE_MIN,
    PAGE_SIZE_MAX,
    MAX_SEARCH_MATCHES,
  };
}
