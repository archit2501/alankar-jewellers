/**
 * Ambient types for the bindings this project actually declares.
 *
 * `cloudflare:workers` exports `env` typed as the global `Env` interface, which
 * each project augments. Keep this in sync with `.openai/hosting.json` (which
 * requests the bindings) and `vite.config.ts` (which simulates them locally).
 *
 * NOTE: `ASSETS` and `IMAGES` are referenced by `worker/index.ts` but are NOT
 * declared by `vite.config.ts`'s `localBindingConfig`, so they are undefined at
 * runtime on this build path and `/_vinext/image` fails. They are deliberately
 * omitted here rather than typed as present — see research/01-codebase.md.
 */
declare namespace Cloudflare {
  interface Env {
    /** Cloudflare D1, requested via `"d1": "DB"` in .openai/hosting.json. */
    DB: D1Database;
    /** Optional outbound webhook for appointment leads. See .env.example. */
    LEAD_WEBHOOK_URL?: string;
  }
}
