// The documents a person gives the assistant (migration 0045 ai_files; docs/model.md §20): what a file IS, read from
// its bytes, never its name; how big each kind may be; and its text, read out once at upload for the assistant to page
// through (read_document). Nothing in a document is ever followed: its text is content (talk.js says so to the model,
// and read_document's every answer says it again).
//
// WHAT READS IT: text, Markdown and CSV here, as they are; PDF and the office formats
// (docx, xlsx, odt) by Cloudflare's own conversion inside this Worker (Workers AI toMarkdown, env.AI), so no other
// company sees the file; a scanned PDF (next to no text a page) and an image by ONE call to a vision model through
// OpenRouter's zero-retention providers, metered on the host like any call (src/assistant/provider.js ask, feature
// "transcribe"). For the checks only, DOCUMENT_CONVERT_VIA (a loopback address) stands in for toMarkdown.
//
//   kindOf(bytes, name)          -> { kind: "text"|"csv"|"pdf"|"docx"|"xlsx"|"odt"|"image", mime } | { bad }
//   readText(env, file, call)    -> { text, pages } | { unreadable: "why, in words" }

/** How big each kind may be, in bytes; how much text a document may give; how many files a conversation holds. */
export const DOCUMENT_LIMITS = {
  text: 1024 * 1024, csv: 1024 * 1024, pdf: 10 * 1024 * 1024, docx: 10 * 1024 * 1024, xlsx: 10 * 1024 * 1024, odt: 10 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  textChars: 500_000,
  perConversation: 5,
  nameChars: 200,
};
/** A PDF with fewer characters a page than this is taken as scanned: its pages are pictures, read by the vision model. */
const SCANNED_CHARS_A_PAGE = 20;

const MIME = {
  text: "text/plain", csv: "text/csv", pdf: "application/pdf", image: null,
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
};

const starts = (b, ...bytes) => bytes.every((x, i) => b[i] === x);
const ascii = (b, from, n) => String.fromCharCode(...b.subarray(from, from + n));

// ── a zip's entries (docx, xlsx and odt are zips: the entry that names the type says which) ──

/** A zip's central directory: [{ name, method, compressed, size, offset }], or null if it isn't one. */
export function zipEntries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true), at = v.getUint32(eocd + 16, true);
  const out = [];
  let p = at;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) return null;
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    out.push({ name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)), method: v.getUint16(p + 10, true),
      compressed: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), offset: v.getUint32(p + 42, true) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/**
 * Bytes inflated, at most `max` of them: the stream is read a chunk at a time and given up at max + 1, so a small
 * entry that inflates to gigabytes (a zip bomb) never fills the Worker's memory. null when it passes max or is broken.
 */
export async function inflateCapped(raw, format, max) {
  let reader;
  try { reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream(format)).getReader(); } catch { return null; }
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { await reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
  } catch { return null; }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One small zip entry's bytes (stored or deflated), at most `max` of them whatever it declares; null if it can't be read. */
export async function zipEntry(b, entry, max = 64 * 1024) {
  if (entry.size > max || entry.compressed > b.length) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(entry.offset, true) !== 0x04034b50) return null;
  const start = entry.offset + 30 + v.getUint16(entry.offset + 26, true) + v.getUint16(entry.offset + 28, true);
  const raw = b.subarray(start, start + entry.compressed);
  if (entry.method === 0) return raw.length > max ? null : raw;
  if (entry.method !== 8) return null;
  return inflateCapped(raw, "deflate-raw", max);
}

/** What an office file is, by the zip entry that names its type ([Content_Types].xml, or ODF's mimetype). */
async function officeKind(b) {
  const entries = zipEntries(b);
  if (!entries) return null;
  const mimetype = entries.find((e) => e.name === "mimetype");
  if (mimetype) {
    const m = new TextDecoder().decode((await zipEntry(b, mimetype, 200)) ?? new Uint8Array()).trim();
    return m === MIME.odt ? "odt" : null;
  }
  const types = entries.find((e) => e.name === "[Content_Types].xml");
  if (!types) return null;
  const xml = new TextDecoder().decode((await zipEntry(b, types)) ?? new Uint8Array());
  if (/wordprocessingml\.document\.main\+xml/.test(xml)) return "docx";
  if (/spreadsheetml\.sheet\.main\+xml/.test(xml)) return "xlsx";
  return null;
}

/** Whether bytes are text a person wrote: valid UTF-8 with no NUL. */
function asText(b) {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
    return s.includes("\u0000") ? null : s.replace(/^﻿/, "");
  } catch { return null; }
}

/** What a file is, read from its bytes (its name only tells CSV from other text): { kind, mime } or { bad }. */
export async function kindOf(bytes, name = "") {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!b.length) return { bad: "The file is empty." };
  if (ascii(b, 0, 5) === "%PDF-") return { kind: "pdf", mime: MIME.pdf };
  if (starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mime: "image/png" };
  if (starts(b, 0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (starts(b, 0x50, 0x4b, 0x03, 0x04)) {
    const k = await officeKind(b);
    return k ? { kind: k, mime: MIME[k] } : { bad: "That's a zip the assistant can't read: a Word (.docx), Excel (.xlsx) or OpenDocument (.odt) file is, other zips aren't." };
  }
  const text = asText(b);
  if (text === null) return { bad: "The assistant reads PDF, Word (.docx), Excel (.xlsx), OpenDocument (.odt), CSV, text and Markdown files, and pictures (PNG, JPEG, WebP)." };
  return /\.csv$/i.test(name) ? { kind: "csv", mime: MIME.csv } : { kind: "text", mime: /\.(md|markdown)$/i.test(name) ? "text/markdown" : MIME.text };
}

/** The most a kind may be, in words: for the refusal and for the app, which shows it before a file is chosen. */
export const limitWords = () => `PDF, Word, Excel and OpenDocument files up to ${DOCUMENT_LIMITS.pdf / 1048576} MB, pictures up to ${DOCUMENT_LIMITS.image / 1048576} MB, text, Markdown and CSV up to ${DOCUMENT_LIMITS.text / 1048576} MB; ${DOCUMENT_LIMITS.perConversation} files a conversation.`;

// ── reading it ──────────────────────────────────────────────────────────────────────────────

/** Most of a PDF's object streams' bytes inflated to count its pages: each, and all together. */
const OBJSTM_MAX = 2 * 1024 * 1024, OBJSTM_TOTAL = 8 * 1024 * 1024;

/** Bytes as one character each (latin1), so a PDF's structure can be read with patterns. */
function latin(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

/** Pages a piece of PDF says it has: its /Type /Page objects, and the biggest /Count of a /Type /Pages node. */
function pagesSaidIn(s) {
  const objects = (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  let tree = 0;
  for (const m of s.matchAll(/<<[^<>]*\/Type\s*\/Pages(?![A-Za-z])[^<>]*>>/g)) {
    const c = /\/Count\s+(\d+)/.exec(m[0]);
    if (c) tree = Math.max(tree, Number(c[1]));
  }
  return Math.max(objects, tree);
}

/**
 * A PDF's pages, or null when they can't be counted: the most of its page objects and its page tree's /Count, read
 * in the file as it is AND inside its object streams (/Type /ObjStm, FlateDecode: since PDF 1.5 most keep their page
 * objects there), each inflated within OBJSTM_MAX and all within OBJSTM_TOTAL. The scanned-page cap and the
 * transcription's reservation both rest on it.
 */
export async function pdfPages(b) {
  const s = latin(b);
  let pages = pagesSaidIn(s), budget = OBJSTM_TOTAL;
  for (const m of s.matchAll(/\/Type\s*\/ObjStm(?![A-Za-z])/g)) {
    const objStart = s.lastIndexOf(" obj", m.index);
    const dictEnd = s.indexOf("stream", m.index);
    if (dictEnd < 0) continue;
    const dict = s.slice(objStart < 0 ? Math.max(0, m.index - 300) : objStart, dictEnd);
    if (!/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) continue;
    let from = dictEnd + "stream".length;
    if (s[from] === "\r") from += 1;
    if (s[from] === "\n") from += 1;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const to = len ? from + Number(len[1]) : s.indexOf("endstream", from);
    if (to <= from || to > b.length || budget <= 0) continue;
    const inflated = await inflateCapped(b.subarray(from, to), "deflate", Math.min(OBJSTM_MAX, budget));
    if (!inflated) continue;
    budget -= inflated.length;
    pages = Math.max(pages, pagesSaidIn(latin(inflated)));
  }
  return pages > 0 ? pages : null;
}

/** PDF or an office file as Markdown: Cloudflare's own conversion (env.AI.toMarkdown), or the checks' stand-in. */
async function converted(env, name, mime, b) {
  const via = (() => {
    try { const u = new URL(env.DOCUMENT_CONVERT_VIA ?? ""); return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ? u.href : null; } catch { return null; }
  })();
  if (via) {
    const res = await fetch(via, { method: "POST", headers: { "Content-Type": mime, "X-File-Name": encodeURIComponent(name) }, body: b });
    if (!res.ok) throw new Error(`the conversion answered ${res.status}`);
    return (await res.json()).markdown ?? "";
  }
  if (!env.AI?.toMarkdown) return null;
  const [r] = await env.AI.toMarkdown([{ name, blob: new Blob([b], { type: mime }) }]);
  if (r?.format === "error") throw new Error(r.error ?? "the conversion failed");
  return r?.data ?? "";
}

/**
 * A document's text, read once: { text, pages } or { unreadable: why }. `transcribe(parts, pages)` is the vision call
 * (talk.js gives it, metered on the host), asked only for a scanned PDF or a picture.
 */
export async function readText(env, { name, kind, mime, bytes }, transcribe) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "", pages = null;
  if (kind === "text" || kind === "csv") text = asText(b) ?? "";
  else if (kind === "image") {
    pages = 1;
    text = await transcribe([{ type: "image_url", image_url: { url: `data:${mime};base64,${base64(b)}` } }], pages);
  } else {
    if (kind === "pdf") pages = await pdfPages(b);
    let md;
    try { md = await converted(env, name, mime, b); } catch (e) { return { unreadable: `It couldn't be read (${String(e?.message ?? e).slice(0, 120)}).` }; }
    if (md === null) return { unreadable: "This site can't read PDF or office files yet: paste the text, or give it as a text or CSV file." };
    text = md;
    if (kind === "pdf" && text.replace(/\s+/g, "").length < SCANNED_CHARS_A_PAGE * (pages ?? 1)) {
      // A scan is read page by page by the model, so its pages must be known: the cap and the reservation rest on them.
      if (!pages) return { unreadable: "It looks scanned, and its pages can't be counted, so it can't be read safely. Upload a version with text in it, or the pages as pictures." };
      text = await transcribe([{ type: "file", file: { filename: name, file_data: `data:application/pdf;base64,${base64(b)}` } }], pages);
    }
  }
  text = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { unreadable: "No text could be read from it." };
  if (text.length > DOCUMENT_LIMITS.textChars) return { unreadable: `It's too long to read: more than ${DOCUMENT_LIMITS.textChars.toLocaleString("en-US")} characters of text.` };
  return { text, pages };
}

function base64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
