/**
 * Stand-in for the `cloudflare:workers` built-in, which only exists inside the
 * Workers runtime. `dist/server/index.js` reaches it through `db/index.ts`, so
 * without this stub the bundle cannot even be imported under plain Node.
 *
 * `env` is intentionally mutable so a test can inject bindings (e.g.
 * `LEAD_WEBHOOK_URL`) and reset them afterwards.
 */
export const env = {};

const cloudflareWorkers = { env };

export default cloudflareWorkers;
