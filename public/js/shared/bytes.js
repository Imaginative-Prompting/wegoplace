// A number of bytes in words, one spelling for every sentence and meter in the app and the
// Worker: divided by 1024, labeled KB, MB and GB, so the free limit reads "1 GB" everywhere.
// Pure and shared: no imports, nothing that runs.

/** "1 GB", "610 MB", "4.5 MB", "12 KB", "0 MB". */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;
  const one = (v) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  // A figure that would round up to 1024 of a unit is one of the next ("1 GB left", never "1024 MB").
  const reaches = (unit) => Math.round(n / unit) >= 1024;
  if (n >= GB || reaches(MB)) return `${one(n / GB)} GB`;
  if (n >= MB || reaches(KB)) return `${one(n / MB)} MB`;
  if (n >= KB) return `${one(n / KB)} KB`;
  return n ? "1 KB" : "0 MB";
}
