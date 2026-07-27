/**
 * Shared request helper. Imports the built Worker bundle once and drives it
 * in-process; `tests/setup.mjs` supplies the `cloudflare:workers` stub that
 * makes that possible under plain Node.
 */
let workerPromise;

function loadWorker() {
  workerPromise ??= import(new URL("../dist/server/index.js", import.meta.url).href).then(
    (module) => module.default
  );
  return workerPromise;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindings = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};

/** Issue a request against the built Worker. */
export async function fetchWorker(path, init = {}) {
  const worker = await loadWorker();
  return worker.fetch(new Request(`http://localhost${path}`, init), bindings, ctx);
}

/** GET a page. Returns the HTML string, or the raw Response with `raw: true`. */
export async function renderPage(path, { raw = false } = {}) {
  const response = await fetchWorker(path, { headers: { accept: "text/html" } });
  return raw ? response : response.text();
}

/** POST JSON and return `{ status, body }` with the body already parsed. */
export async function postJson(path, payload, headers = {}) {
  const response = await fetchWorker(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { status: response.status, body, response };
}
