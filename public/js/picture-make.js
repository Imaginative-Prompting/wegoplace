// A picture made on the phone to the size the server keeps, before it goes anywhere: a receipt,
// a place's or a plan's photo, a trip's cover (public/js/shared/limits.js PICTURE_LIMITS).
//
//   await makePicture(file, limits)  -> { blob, w, h, type }   or throws an Error whose message can be shown
//
// The long side to `limits.px`, as a JPEG under `limits.bytes`: the quality steps down first and
// the size only after (small print reads better large and a little soft than small and sharp).
// Drawn on white, so a picture with a clear background reads as paper. An <img> decodes it, which
// turns a phone photo the right way up (EXIF orientation is applied to naturalWidth and to
// drawImage in every browser this app supports); the canvas carries none of the file's data, so
// its place and camera are gone.

const toBlob = (canvas, q) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));

export async function makePicture(file, limits) {
  if (!limits || !(limits.px > 0) || !(limits.bytes > 0)) throw new Error("makePicture: no limits given.");
  if (!file || !/^image\//.test(file.type || "image/")) throw new Error("That isn't a picture.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try { await img.decode(); } catch { throw new Error("That picture couldn't be opened on this phone."); }
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error("That picture couldn't be opened on this phone.");
    let scale = Math.min(1, limits.px / Math.max(w0, h0));
    for (let round = 0; round < 6; round++) {
      const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, w, h);
      for (const q of [0.86, 0.78, 0.7, 0.62]) {
        const blob = await toBlob(canvas, q);
        if (blob && blob.size <= limits.bytes) return { blob, w, h, type: "image/jpeg" };
      }
      scale *= 0.8;
    }
    throw new Error("That picture couldn't be made small enough to keep.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
