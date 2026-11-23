// What the site's log may hold. Cloudflare keeps every line a Worker writes, so no line may carry a person's words, a
// trip's titles, a document's text, a phone's push address or a key: checks/log/quiet.mjs reads every console call
// under src/ and holds that each one goes through errorLine() or is on its list of lines that carry none of that.
//
// An error's MESSAGE is what can carry it: a JSON SyntaxError quotes the text it read, a validation error the value
// it refused, a fetch error the address it was sent to, and a provider's refusal what it was sent. So an error goes into
// the log as its name, its code and where in the code it was thrown (the stack's frames, file and line), never as its
// message. On this machine (wrangler dev: the checks, the bake-off) the message comes too, for whoever is debugging.

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Whether this Worker runs on this machine (wrangler dev), where a log line may hold an error's words. */
export const onThisMachine = (env) => LOCAL.test(env?.PUBLIC_ORIGIN ?? "");

/** An error as the site's log may hold it: { name, code, at } (and its message on this machine). */
export function errorLine(e, env) {
  const at = String(e?.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => l.trim()).join(" | ");
  return {
    name: typeof e?.name === "string" ? e.name : typeof e,
    code: typeof e?.code === "string" || typeof e?.code === "number" ? e.code : null,
    at: at || null,
    ...(onThisMachine(env) ? { message: String(e?.message ?? e).slice(0, 500) } : {}),
  };
}
