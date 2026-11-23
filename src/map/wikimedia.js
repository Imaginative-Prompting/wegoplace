// A credited photo of a real place, where a free one exists: Wikidata's item for the place (found by its name, and
// kept only if the item's own coordinates are within PICTURE_NEAR_M of the place), its image (P18), and Wikimedia
// Commons' record of that file (its license, its author, its page). The answer is what set_picture takes: { url,
// license, credit, source }.
//
// THE FILE IS COMMONS' OWN SIZED COPY, never the original (often thousands of pixels and megabytes, sometimes a TIFF,
// an SVG or a PDF): set_picture keeps at most PICTURE_LIMITS.picture (1600 px on the long side, 600 KB, JPEG/PNG/WebP/
// AVIF). Commons renders sized copies at its standard widths only (1280, 960: src/trips/pictures.js), always as JPEG or
// PNG; a portrait whose 1280-wide copy would pass 1600 px tall takes the 960 one, and one too tall even then is "nothing
// found".
//
// FREE LICENSES ONLY: CC0, public domain, CC BY and CC BY-SA, read from the file's LicenseShortName. Anything else
// (fair use, a non-commercial license, none named) is "nothing found": the trip's pictures are shown to everyone on
// it and may be shared, so only a license that allows that is kept. The credit is the file's Artist with its HTML
// taken out, as set_picture keeps a credit.
//
// Every request names the site (cut.js agentOf), as Wikimedia's User-Agent policy asks. For the checks only,
// WIKIMEDIA_API_VIA (a loopback address) receives every request instead, naming the address asked in X-Fetch-For,
// as PICTURE_FETCH_VIA does for picture fetches (src/trips/pictures.js).

import { agentOf } from "./cut.js";
import { distanceM, sameName } from "./pois.js";

export const PICTURE_NEAR_M = 500;
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const TIMEOUT_MS = 8000;

/** Whether a Commons LicenseShortName is a free one this keeps. */
// A trailing word is only ever a jurisdiction ("CC BY-SA 3.0 nl") or "IGO" on Commons; "nc" or "nd" there is refused.
export const freeLicense = (name) => /^(cc0(\s*1\.0)?|public domain|pd(-[\w.-]+)?|cc[ -]by(-sa)?(\s+\d(\.\d)?)?(\s+(?!nc\b|nd\b)([a-z]{2}|igo))?)$/i.test(String(name ?? "").trim());

/** The long side set_picture keeps, and the sized copies Commons renders (widths). */
const LONG_SIDE_MAX = 1600;
const WIDTHS = [1280, 960];

/** Text with its HTML tags and entities taken out, on one line. */
export const plainText = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

function via(env) {
  const set = env?.WIKIMEDIA_API_VIA;
  if (!set) return null;
  try {
    const u = new URL(set);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.href;
  } catch { /* not an address */ }
  console.warn("[wikimedia] WIKIMEDIA_API_VIA is not a loopback address; requests go to Wikimedia");
  return null;
}

async function getJson(env, url) {
  const stand = via(env);
  const headers = { "User-Agent": agentOf(env), Accept: "application/json" };
  const res = await fetch(stand ?? url, { headers: stand ? { ...headers, "X-Fetch-For": url } : headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikimedia answered ${res.status}`);
  return res.json();
}

/**
 * A free, credited photo of the place named, at that spot: { found: true, url, license, credit, source, wikidata,
 * distance_m } or { found: false, why }. Two or three requests.
 */
export async function findPicture(env, { name, lat, lng }) {
  const q = (base, params) => `${base}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  let search;
  try { search = await getJson(env, q(WIKIDATA, { action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "7" })); }
  catch (e) { return { found: false, why: `Wikidata couldn't be asked just now (${e.message})` }; }
  const ids = (search?.search ?? []).filter((s) => sameName(s.label ?? "", name) || (s.aliases ?? []).some((a) => sameName(a, name)) || sameName(s.match?.text ?? "", name)).map((s) => s.id).slice(0, 5);
  if (!ids.length) return { found: false, why: "Wikidata has no item by that name" };
  let items;
  try { items = await getJson(env, q(WIKIDATA, { action: "wbgetentities", ids: ids.join("|"), props: "claims" })); }
  catch (e) { return { found: false, why: `Wikidata couldn't be asked just now (${e.message})` }; }
  const near = [];
  for (const id of ids) {
    const claims = items?.entities?.[id]?.claims ?? {};
    const at = claims.P625?.[0]?.mainsnak?.datavalue?.value;
    const file = claims.P18?.[0]?.mainsnak?.datavalue?.value;
    if (!at || typeof file !== "string") continue;
    const d = distanceM({ lat, lng }, { lat: at.latitude, lng: at.longitude });
    if (d <= PICTURE_NEAR_M) near.push({ id, file, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (!near.length) return { found: false, why: `no Wikidata item of that name with a photo within ${PICTURE_NEAR_M} m of the place` };
  for (const n of near) {
    let info;
    try { info = await getJson(env, q(COMMONS, { action: "query", titles: `File:${n.file}`, prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: String(WIDTHS[0]) })); }
    catch (e) { return { found: false, why: `Wikimedia Commons couldn't be asked just now (${e.message})` }; }
    const ii = info?.query?.pages?.[0]?.imageinfo?.[0];
    const meta = ii?.extmetadata ?? {};
    const license = plainText(meta.LicenseShortName?.value);
    if (!ii?.thumburl || !freeLicense(license)) continue;
    let url, width, height;
    if (!/\/thumb\//.test(new URL(ii.thumburl).pathname)) {
      // Commons gave the original itself (it is no wider than asked): kept only if it already fits as it is.
      if (Math.max(ii.width, ii.height) > LONG_SIDE_MAX || !/\.(jpe?g|png|webp)$/i.test(new URL(ii.thumburl).pathname)) continue;
      url = new URL(ii.thumburl); width = ii.width; height = ii.height;
    } else {
      // A sized copy: 1280 wide, or 960 for a portrait that would pass the long side; none if even 960 does.
      const ratio = ii.height / ii.width;
      width = WIDTHS.find((w) => Math.round(w * ratio) <= LONG_SIDE_MAX && w <= ii.width);
      if (!width) continue;
      height = Math.round(width * ratio);
      url = new URL(ii.thumburl);
      url.pathname = url.pathname.replace(/\/\d+px-([^/]+)$/, `/${width}px-$1`);
    }
    url.search = "";
    const credit = plainText(meta.Artist?.value) || plainText(meta.Credit?.value) || "Wikimedia Commons";
    return { found: true, url: url.href, width, height, license, credit: credit.slice(0, 200), source: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(n.file)}`, wikidata: n.id, distance_m: Math.round(n.d) };
  }
  return { found: false, why: "its photo isn't under a free license (CC0, public domain, CC BY or CC BY-SA), so it isn't used" };
}
