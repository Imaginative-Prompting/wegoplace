/* PNG decode + the pixel measures the iOS takes are read with. Dependency-free on purpose:
 * puppeteer is not installed on this machine and must not be. */
const zlib = require("zlib");
const fs = require("fs");

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported png ${bitDepth}/${colorType}`);
      if (data[12] !== 0) throw new Error("interlaced png");
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const cc = prior && x >= bpp ? prior[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      } else if (filter !== 0) throw new Error("bad png filter " + filter);
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

/* Ink = pixels far from the local median inside a box. Glyphs are ink; a flat fill is not. */
function inkIn(png, rx, ry, rw, rh, thresh = 24) {
  const { w, bpp, data } = png;
  const x0 = Math.max(0, Math.round(rx)), y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(w, Math.round(rx + rw)), y1 = Math.min(png.h, Math.round(ry + rh));
  const lum = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = (y * w + x) * bpp;
    lum.push(0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]);
  }
  if (!lum.length) return { ink: 0, n: 0, med: 0 };
  const s = [...lum].sort((a, b) => a - b);
  const med = s[s.length >> 1];
  let n = 0;
  for (const v of lum) if (Math.abs(v - med) > thresh) n++;
  return { ink: n, n: lum.length, med: +med.toFixed(1) };
}

/* ASCII luminance crop so a human (me) can literally read the pixels. */
function asciiCrop(png, rx, ry, rw, rh, cols = 64) {
  const { w, bpp, data } = png;
  const x0 = Math.max(0, Math.round(rx)), y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(w, Math.round(rx + rw)), y1 = Math.min(png.h, Math.round(ry + rh));
  const bw = Math.max(1, Math.round((x1 - x0) / cols));
  const bh = Math.max(1, bw * 2);
  const ramp = " .:-=+*#%@";
  const lines = [];
  for (let y = y0; y < y1; y += bh) {
    let line = "";
    for (let x = x0; x < x1; x += bw) {
      let sum = 0, n = 0;
      for (let yy = y; yy < Math.min(y + bh, y1); yy++) for (let xx = x; xx < Math.min(x + bw, x1); xx++) {
        const j = (yy * w + xx) * bpp;
        sum += 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]; n++;
      }
      const v = n ? sum / n : 0;
      line += ramp[Math.min(ramp.length - 1, Math.floor((v / 255) * ramp.length))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/* Desaturate: replace every pixel with its luminance. Proves a signal is not hue-only. */
function desaturate(png) {
  const out = Buffer.from(png.data);
  for (let i = 0; i < out.length; i += png.bpp) {
    const l = Math.round(0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]);
    out[i] = out[i + 1] = out[i + 2] = l;
  }
  return { ...png, data: out };
}

function writePNG(file, png) {
  const { w, h, bpp, data } = png;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunks = [];
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk("IHDR", ihdr));
  chunks.push(chunk("IDAT", zlib.deflateSync(raw)));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  fs.writeFileSync(file, Buffer.concat(chunks));
}
let CRCT = null;
function crc32(buf) {
  if (!CRCT) { CRCT = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRCT[n] = c; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}


module.exports = { decodePNG, inkIn, asciiCrop, desaturate, writePNG };
