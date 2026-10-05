'use strict';

/* ============================================================
 * Thief Tab —— EPUB 解析（零依赖）
 * ZIP：字节级解析 central directory + 原生 DecompressionStream('deflate-raw')，
 *      支持 ZIP64 占位 EOCD、流式解压上限（防解压炸弹）、逐条目容错、文件名编码别名；
 * OPF / XHTML：DOMParser；只提取 spine 文本，图片与样式一律忽略。
 * 纯本地运行，无任何网络请求。
 * ============================================================ */

// ---------- ZIP 层（纯字节，可在 Node 中单测） ----------
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u64(b, o) {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

function latin1(b, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[start + i]);
  return s;
}

/** 解析 ZIP central directory，返回 [{ name, nameBytes, nameUtf8, method, uncompressedSize, data }] */
function zipEntries(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (u32(u8, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 结构错误（未找到 EOCD）');
  let count = u16(u8, eocd + 10);
  let cdOffset = u32(u8, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    // ZIP64 占位：经 locator（EOCD 前 20 字节）定位 ZIP64 EOCD 取真实值
    if (eocd >= 20 && u32(u8, eocd - 20) === 0x07064b50 && u32(u8, eocd - 12) !== 0xffffffff) {
      const z64 = u64(u8, eocd - 12);
      if (z64 + 56 <= u8.length && u32(u8, z64) === 0x06064b50) {
        count = u64(u8, z64 + 32);
        cdOffset = u64(u8, z64 + 48);
      }
    }
  }
  if (cdOffset + 46 > u8.length) throw new Error('ZIP 结构错误（central directory 越界）');
  const entries = [];
  let ptr = cdOffset;
  for (let n = 0; n < count && ptr + 46 <= u8.length; n++) {
    if (u32(u8, ptr) !== 0x02014b50) throw new Error('ZIP 结构错误（central directory）');
    const flags = u16(u8, ptr + 8);
    const method = u16(u8, ptr + 10);
    const uncompressedSize = u32(u8, ptr + 24);
    const compressedSize = u32(u8, ptr + 20);
    const nameLen = u16(u8, ptr + 28);
    const extraLen = u16(u8, ptr + 30);
    const commentLen = u16(u8, ptr + 32);
    const localOffset = u32(u8, ptr + 42);
    const nameBytes = u8.slice(ptr + 46, ptr + 46 + nameLen); // slice 复制，aliases 需要
    const nameUtf8 = (flags & 0x800) !== 0;
    const name = nameUtf8 ? new TextDecoder().decode(nameBytes) : latin1(u8, ptr + 46, nameLen);
    if (!(flags & 0x1) && u32(u8, localOffset) === 0x04034b50) { // 跳过加密项
      const lNameLen = u16(u8, localOffset + 26);
      const lExtraLen = u16(u8, localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compressedSize <= u8.length) {
        entries.push({
          name, nameBytes, nameUtf8, method, uncompressedSize,
          data: u8.subarray(dataStart, dataStart + compressedSize),
        });
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 流式解压，超出 maxBytes 立即中止（防 CD 谎报 / 解压炸弹） */
async function inflateRaw(data, maxBytes) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* 忽略 */ }
      throw new Error('解压超出大小上限');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** latin1 文件名按 UTF-8 / GBK 重解出候选别名（兼容未设 0x800 标志的中文打包器） */
function nameAliases(entry) {
  if (entry.nameUtf8) return [];
  const aliases = [];
  try {
    const bytes = Uint8Array.from(entry.name, (c) => c.charCodeAt(0) & 0xff);
    const asUtf8 = new TextDecoder('utf-8').decode(bytes);
    if (asUtf8 !== entry.name) aliases.push(asUtf8);
  } catch (e) { /* 忽略 */ }
  try {
    const bytes = Uint8Array.from(entry.name, (c) => c.charCodeAt(0) & 0xff);
    const asGbk = new TextDecoder('gbk').decode(bytes);
    if (asGbk !== entry.name && !aliases.includes(asGbk)) aliases.push(asGbk);
  } catch (e) { /* 忽略 */ }
  return aliases;
}

/** ZIP → Map<name, Uint8Array（已解压）>；单条目失败/超大时跳过，不拖垮整本。
 *  预算可注入（opts.maxEntry / opts.maxTotal，字节）：默认 100MB/200MB；
 *  单测用 KB 级等比预算复现同一语义，避免真实解压数百 MB。 */
async function zipRead(buf, opts = {}) {
  const MAX_UNCOMPRESSED = opts.maxEntry ?? 100 * 1024 * 1024;
  const MAX_TOTAL = opts.maxTotal ?? 200 * 1024 * 1024; // 全书累计解压上限：单条目有界仍可能多条目叠加膨胀，打爆内存
  const out = new Map();
  let totalOut = 0;
  for (const e of zipEntries(buf)) {
    let data = null;
    if (e.uncompressedSize > MAX_UNCOMPRESSED) continue; // 声明值就超标
    const cap = Math.min(MAX_UNCOMPRESSED, e.uncompressedSize + 65536); // 声明值 + 容差
    try {
      if (e.method === 0) {
        if (e.data.byteLength <= cap) data = e.data;
      } else if (e.method === 8) {
        data = await inflateRaw(e.data, cap);
      }
    } catch (err) {
      continue; // 坏条目（截断/损坏/超限）跳过，其余章节不受影响
    }
    if (!data) continue;
    if (totalOut + data.byteLength > MAX_TOTAL) continue; // 超出全书预算：跳过该条目
    totalOut += data.byteLength;
    out.set(e.name, data);
    for (const alias of nameAliases(e)) {
      if (!out.has(alias)) out.set(alias, data); // 别名共享同一份 data，不重复计入预算
    }
  }
  return out;
}

/** 相对路径解析（处理 ./ 与 ../，兼容反斜杠） */
function resolvePath(baseDir, href) {
  let h;
  try { h = decodeURIComponent(href); } catch (e) { h = href; }
  const out = [];
  for (const p of (baseDir + h).replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

// ---------- XHTML → 纯文本（DOM 遍历，块级元素转换行） ----------
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'LINK', 'META', 'TEMPLATE', 'SVG', 'IFRAME']);
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'TR', 'TABLE', 'UL', 'OL', 'FIGURE', 'FIGCAPTION', 'HEADER', 'FOOTER',
  'MAIN', 'ASIDE', 'HR', 'PRE', 'DL', 'DT', 'DD', 'BODY', 'HTML',
]);

function nodeToText(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out.push(child.nodeValue);
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'BR') { out.push('\n'); continue; }
      const block = BLOCK_TAGS.has(tag);
      if (block) out.push('\n');
      nodeToText(child, out);
      if (block) out.push('\n');
    }
  }
}

function htmlToText(doc) {
  const out = [];
  nodeToText(doc.body || doc.documentElement, out);
  return out.join('');
}

// ---------- EPUB 入口 ----------
async function parseEpub(buf) {
  const files = await zipRead(buf);
  const containerRaw = files.get('META-INF/container.xml');
  if (!containerRaw) throw new Error('不是有效的 EPUB（缺少 container.xml）');
  const container = new DOMParser().parseFromString(new TextDecoder().decode(containerRaw), 'application/xml');
  const rootfile = container.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 缺少 OPF 描述');
  const opfRaw = files.get(opfPath);
  if (!opfRaw) throw new Error('EPUB 缺少 OPF 文件：' + opfPath);
  const opf = new DOMParser().parseFromString(new TextDecoder().decode(opfRaw), 'application/xml');

  const titleEl = opf.getElementsByTagNameNS('*', 'title')[0];
  const title = titleEl ? titleEl.textContent.trim() : '';

  const items = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    const id = it.getAttribute('id');
    if (id) items.set(id, { href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '' });
  }
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const parts = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const item = items.get(ref.getAttribute('idref'));
    if (!item) continue;
    const looksHtml = /x?html/i.test(item.type) || /\.x?html?$/i.test(item.href);
    if (!looksHtml) continue;
    const raw = files.get(resolvePath(opfDir, item.href));
    if (!raw) continue;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(raw), 'text/html');
    const text = htmlToText(doc);
    if (text.trim()) parts.push(text);
  }
  if (!parts.length) throw new Error('EPUB 中未提取到文本内容');
  return { title, text: parts.join('\n\n') };
}

// Node 单测导出（浏览器环境没有 module，忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { zipEntries, zipRead, resolvePath, htmlToText, parseEpub, inflateRaw, nameAliases };
}
