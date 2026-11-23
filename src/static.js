// Static files: what is in public/, served by Cloudflare's asset server (the ASSETS binding).

/** A response whose headers can still be changed (one from fetch() or Response.redirect() can't). */
export function fresh(response) {
  // A socket's 101 goes as it came: a copy would lose the socket.
  if (response.status === 101) return response;
  return new Response([204, 205, 304].includes(response.status) ? null : response.body, response);
}

/**
 * The file a request names, or the app's page when it names none. Only for the few requests
 * that reach the Worker and turn out to be for a file: a page served at a second address
 * (below), or an address under /login/ or /join/ that no route answers. Every other file is
 * answered by the asset server without the Worker, with the headers public/_headers gives it;
 * a file fetched through the binding here gets the same ones.
 */
export async function staticFile(request, env) {
  return fresh(await env.ASSETS.fetch(request));
}

/**
 * The app at one trip's address. /t/<id>/ answers the app's own document, the same bytes and
 * headers as /, and the app reads the trip from its address; /t/<id> goes to the slash form,
 * so there is one address for each trip and the page's relative addresses resolve one way.
 */
export const appAt = ({ request, env }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
    return new Response(null, { status: 308, headers: { Location: `${url.pathname}${url.search}`, "Cache-Control": "no-store" } });
  }
  return staticFile(new Request(new URL("/", request.url), { headers: request.headers }), env);
};

/** A page of public/ served at another address: the sign-in page is also /login/new and /login/link/<token>, the join page /join/<code>. */
export const pageAt = (page) => ({ request, env }) =>
  staticFile(new Request(new URL(page, request.url), { headers: request.headers }), env);
