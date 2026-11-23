// A stand-in for OpenRouter on this machine, for the assistant's checks (src/assistant/): its chat
// completions and its record of a call, kept in memory. Nothing reaches OpenRouter or any model.
//
//   const model = await startModel({ key: "sk-or-check" });
//   model.base                       its address: the Worker's OPENROUTER_API_BASE (honoured only on a local copy)
//   model.next(answer)               what the next call answers, in turn (else words, "OK", at 0.0001 $):
//       { words } | { tools: [{ name, arguments }] }   the message
//       cost: dollars | null          usage.cost (null: none in the answer)
//       record: dollars | null        what GET /api/v1/generation says of it later (null: no record)
//       status: n                     an HTTP refusal instead (the body { error })
//       hang: ms                      answers only after this long (a call still out)
//       usage: { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens },
//                completion_tokens_details: { reasoning_tokens } }
//       reasoning_details: [ … ]      carried on the message, as a model that thinks sends them
//       finish: "length" …            the answer's finish_reason (default: "tool_calls" or "stop"); words: null answers no content
//       error: "words"                with status: OpenRouter's error message in the refusal's body
//       errorBody: { … }               with status: the refusal's whole error object instead (code, metadata …)
//   model.calls                      every chat call: { auth, body } (the body as sent: model, tools, provider, user …)
//   model.lookups                    every record asked for: the generation ids
//   model.close()

import http from "node:http";

export async function startModel({ key }) {
  const queue = [];
  const calls = [];
  const lookups = [];
  const records = new Map();
  let n = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const u = new URL(req.url, "http://stand-in");
      const send = (status, body) => { if (!res.writableEnded) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } };
      const auth = req.headers.authorization === `Bearer ${key}`;
      if (req.method === "GET" && u.pathname === "/api/v1/generation") {
        const id = u.searchParams.get("id");
        lookups.push(id);
        if (!auth) return send(401, { error: { message: "No auth" } });
        const r = records.get(id);
        return r === undefined || r === null ? send(404, { error: { message: "Not found yet" } }) : send(200, { data: { id, total_cost: r } });
      }
      if (req.method !== "POST" || u.pathname !== "/api/v1/chat/completions") return send(404, { error: { message: "not the API" } });
      let body = null;
      try { body = JSON.parse(raw); } catch { /* broken */ }
      calls.push({ auth, body });
      if (!auth) return send(401, { error: { message: "No auth" } });
      const a = queue.shift() ?? {};
      if (a.hang) await new Promise((r) => setTimeout(r, a.hang));
      if (a.status) return send(a.status, { error: a.errorBody ?? { message: a.error ?? "The stand-in refused" } });
      const id = `gen-check-${++n}`;
      records.set(id, a.record === undefined ? null : a.record);
      const message = a.tools
        ? { role: "assistant", content: null, tool_calls: a.tools.map((t, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) }
        : { role: "assistant", content: a.words === undefined ? "OK" : a.words };
      if (a.reasoning_details) message.reasoning_details = a.reasoning_details;
      const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, ...(a.usage ?? {}) };
      const cost = a.cost === undefined ? 0.0001 : a.cost;
      if (cost !== null) usage.cost = cost;
      send(200, { id, object: "chat.completion", model: body?.model, choices: [{ index: 0, message, finish_reason: a.finish ?? (a.tools ? "tool_calls" : "stop") }], usage });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, calls, lookups,
    next: (answer) => { queue.push(answer); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
