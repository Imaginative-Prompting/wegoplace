// Which label fonts a map needs offline. A map draws its labels with glyph files of 256 characters
// each (/tiles/fonts/<font>/<start>-<end>.pbf), fetched as the labels need them; with no signal, a
// phone has only the ranges it fetched before. So a cut reads every label in the tiles it writes
// (the values of the keys the app's style draws, LABEL_KEYS, in each vector tile) and lists the ranges those
// characters fall in; the snapshot carries the list, and a phone fetches exactly those ranges
// after it keeps the map (wgp-client's piece).
//
// A vector tile is a protocol buffer (Mapbox Vector Tile 2.1): layers, each with keys, values and
// features whose tags are pairs of indexes into them. Only what this needs is read.

const ungzip = async (bytes) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
};

function varint(b, p) {
  let v = 0, s = 0, x;
  do { x = b[p.i++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
  return v;
}
/** The fields of one message: [{ field, wire, value }], value a number or a subarray. */
function fields(b) {
  const p = { i: 0 };
  const out = [];
  while (p.i < b.length) {
    const tag = varint(b, p);
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) out.push({ field, wire, value: varint(b, p) });
    else if (wire === 2) { const n = varint(b, p); out.push({ field, wire, value: b.subarray(p.i, p.i + n) }); p.i += n; }
    else if (wire === 5) p.i += 4;
    else if (wire === 1) p.i += 8;
    else throw new Error(`a vector tile with a wire type ${wire}`);
  }
  return out;
}
const decoder = new TextDecoder();

/**
 * The keys whose text the app's map draws: the basemap style's own (public/vendor/basemaps, built in
 * public/js/map.js with { lang: "en" }) coalesces the English name, the local name and Protomaps'
 * names in other scripts. Other languages' names (name:zh, name:ko, …) aren't drawn, so their
 * characters aren't needed.
 */
export const LABEL_KEYS = ["name", "name:en", "pgf:name", "pgf:name2", "pgf:name3"];

/** The label text in one vector tile's (plain) bytes: the values of its features' name keys. */
export function labelsIn(tile) {
  const texts = [];
  for (const layer of fields(tile).filter((f) => f.field === 3 && f.wire === 2)) {
    const parts = fields(layer.value);
    const keys = parts.filter((f) => f.field === 3).map((f) => decoder.decode(f.value));
    const values = parts.filter((f) => f.field === 4).map((f) => {
      const s = fields(f.value).find((v) => v.field === 1 && v.wire === 2);
      return s ? decoder.decode(s.value) : null;
    });
    const nameKeys = new Set(keys.map((k, i) => (LABEL_KEYS.includes(k) ? i : -1)).filter((i) => i >= 0));
    if (!nameKeys.size) continue;
    const used = new Set();
    for (const feature of parts.filter((f) => f.field === 2)) {
      const tags = fields(feature.value).find((f) => f.field === 2 && f.wire === 2);
      if (!tags) continue;
      const p = { i: 0 };
      while (p.i < tags.value.length) {
        const k = varint(tags.value, p), v = varint(tags.value, p);
        if (nameKeys.has(k) && values[v] !== null && values[v] !== undefined) used.add(v);
      }
    }
    for (const v of used) texts.push(values[v]);
  }
  return texts;
}

/**
 * Whether MapLibre draws a character from the phone's own font instead of fetching its range:
 * CJK ideographs, kana, Hangul and their neighbours. Copied VERBATIM from the vendored MapLibre,
 * maplibre-gl@6.4.1 public/vendor/maplibre/maplibre-gl-shared.mjs, function Lc (exported as rn,
 * imported by maplibre-gl.mjs as Gn), which GlyphManager._charUsesLocalIdeographFontFamily asks,
 * and _getAndCacheGlyphsPromise asks that before downloading a range: true means it never asks.
 * It applies while localIdeographFontFamily is set, which is MapLibre's default (public/js/map.js
 * doesn't change it). check:map holds this copy equal to the vendored function, and checks/map/
 * draw.mjs holds that every range MapLibre asks for while drawing a real cut is on the list.
 */
export function drawnFromPhoneFont(e) {return/[\u02EA\u02EB\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]|\uD81B[\uDFE0-\uDFFF]|[\uD81C-\uD822\uD840-\uD868\uD86A-\uD86D\uD86F-\uD872\uD874-\uD879\uD880-\uD883\uD885-\uD88C][\uDC00-\uDFFF]|\uD823[\uDC00-\uDCD5\uDCFF-\uDD1E\uDD80-\uDDF2]|\uD82B[\uDFF0-\uDFFF]|\uD82C[\uDC00-\uDEFB]|\uD83C[\uDE00-\uDEFF]|\uD869[\uDC00-\uDEDF\uDF00-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEAD\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0\uDFF0-\uDFFF]|\uD87B[\uDC00-\uDE5D]|\uD87E[\uDC00-\uDE1D]|\uD884[\uDC00-\uDF4A\uDF50-\uDFFF]|\uD88D[\uDC00-\uDC79]/gim.test(String.fromCodePoint(e))}

/** The label fonts hold the first 65,536 characters (256 ranges, as basemaps-assets ships them). */
export const GLYPH_CEILING = 0x10000;

/**
 * A collector for a cut: read(tile bytes as stored), then done() -> the ranges' starts, sorted
 * ("0-255", …), and beyond() -> how many ranges the labels touched above U+FFFF. Those are left
 * off the list: no font file holds them (in Kyoto's center, CJK extension characters and a
 * variation selector, 3 ranges, 14 Nov), so a phone asking for them would only get 404s; the label
 * draws without those characters. The count stays in the cut's own record, never in a sentence.
 */
export function glyphRanges() {
  const starts = new Set();
  const local = new Set();     // ranges of characters drawn from the phone's font only
  return {
    async read(stored) {
      let plain;
      try { plain = await ungzip(stored); } catch { return; }
      let texts;
      try { texts = labelsIn(plain); } catch { return; }
      // A character MapLibre draws from the phone's font is never fetched, so its range isn't kept
      // for it (Kyoto's center: 4.4 of 4.9 MB, kept once per font stack, 14 Nov).
      for (const t of texts) for (const ch of t) { const c = ch.codePointAt(0); if (drawnFromPhoneFont(c)) local.add(Math.floor(c / 256) * 256); else starts.add(Math.floor(c / 256) * 256); }
    },
    async done() {
      return [...starts].filter((s) => s < GLYPH_CEILING).sort((a, b) => a - b).map((s) => `${s}-${s + 255}`);
    },
    beyond: () => [...starts].filter((s) => s >= GLYPH_CEILING).length,
    /** How many ranges the labels touched only with characters drawn from the phone's font. */
    local: () => [...local].filter((s) => !starts.has(s)).length,
  };
}
