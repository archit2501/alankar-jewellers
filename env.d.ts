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
    /**
     * Cloudflare R2, requested via `"r2": "MEDIA"` in .openai/hosting.json —
     * the value of that field IS the binding name. Product photography uploaded
     * from the admin panel lands here.
     *
     * NOTE: the /_vinext/image optimizer cannot serve R2 objects without a code
     * change to worker/index.ts, because it resolves assets through `env.ASSETS`
     * (which this build path never declares anyway). See research/02-market-tech.md
     * §6.3 before wiring uploads to a rendering path.
     */
    MEDIA: R2Bucket;
    /** Optional outbound webhook for appointment leads. See .env.example. */
    LEAD_WEBHOOK_URL?: string;
  }
}
