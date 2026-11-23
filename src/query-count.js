// How many D1 queries one request makes, for check:queries. Workers count them against a limit per
// invocation: 50 on the free plan, 1,000 on the paid one. A db.batch() is one query against it
// however many statements it holds (Cloudflare's D1 limits page); every first(), all(), run() and
// raw() is one. Every request this site answers is held to the free plan's 50, so that a copy run
// on a free account is the same app.
//
// Counting is on only where it's asked for and harmless: COUNT_QUERIES=on, on a site whose own
// address is this machine (a check's server). It then wraps env.DB for the request and writes one
// log line when the answer is ready: {"d1_queries": n, "rows_read", "rows_written", "method", "path", "tool"}.
// The rows are D1's own count from each query's meta (what D1 bills): all(), run() and batch() answer
// it; first() is answered from all() here so its meta is seen (the same query, the first row of it).

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const countingOn = (env) => (env.COUNT_QUERIES === "on" || env.COUNT_QUERIES === "detail") && LOCAL.test(env.PUBLIC_ORIGIN ?? "");

/** env with its DB counted into `tally.n`. */
export function counted(env, tally) {
  tally.read ??= 0;
  tally.written ??= 0;
  // COUNT_QUERIES=detail: each query's first words and its rows too (tools/trip-cost.mjs --detail).
  const detail = env.COUNT_QUERIES === "detail" ? (tally.detail ??= []) : null;
  const add = (meta, sql) => {
    tally.read += Number(meta?.rows_read) || 0; tally.written += Number(meta?.rows_written) || 0;
    if (detail && sql) detail.push({ sql: String(sql).replace(/\s+/g, " ").slice(0, 160), read: Number(meta?.rows_read) || 0 });
  };
  const sqlOf = new WeakMap();                                 // a statement -> its SQL, for the detail
  const real = new WeakMap();                                  // a counted statement -> D1's own
  const statement = (s) => {
    const proxy = new Proxy(s, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "bind") return (...args) => { const b = statement(v.apply(target, args)); sqlOf.set(b, sqlOf.get(proxy)); return b; };
        if (prop === "all" || prop === "run") return async (...args) => { tally.n += 1; const r = await v.apply(target, args); add(r?.meta, sqlOf.get(proxy)); return r; };
        if (prop === "first") return async (column) => {
          tally.n += 1;
          const r = await target.all();
          add(r?.meta, sqlOf.get(proxy));
          const row = r?.results?.[0] ?? null;
          return column === undefined ? row : row === null ? null : row[column];
        };
        if (prop === "raw") return (...args) => { tally.n += 1; return v.apply(target, args); };
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(proxy, s);
    return proxy;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "prepare") return (sql) => { const st = statement(v.call(target, sql)); sqlOf.set(st, sql); return st; };
      if (prop === "batch") return async (list) => { tally.n += 1; const rs = await v.call(target, list.map((s) => real.get(s) ?? s)); (rs ?? []).forEach((r, i) => add(r?.meta, sqlOf.get(list[i]))); return rs; };
      if (prop === "exec") return (...args) => { tally.n += 1; return v.apply(target, args); };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...env, DB: db };
}

/** One request's line in the log. */
export function logCount(tally, request, extra = {}) {
  const url = new URL(request.url);
  console.log(JSON.stringify({ d1_queries: tally.n, rows_read: tally.read ?? 0, rows_written: tally.written ?? 0, method: request.method, path: url.pathname, ...extra, ...(tally.detail ? { detail: tally.detail } : {}) }));
}
