/**
 * Ambient types for the bindings this project actually declares.
 *
 * `cloudflare:workers` exports `env` typed as the global `Env` interface, which
 * each project augments. Three files decide what is really bound, and they
 * MERGE rather than override:
 *
 *   wrangler.jsonc            assets (ASSETS) and images (IMAGES)
 *   vite.config.ts            d1_databases, r2_buckets  (a CUSTOMIZER, not a
 *                             replacement — @cloudflare/vite-plugin merges it
 *                             over wrangler.jsonc)
 *   .openai/hosting.json      which of d1/r2 vite.config.ts asks for at all
 *
 * HISTORY, because the comment that used to live here said the opposite and was
 * true when written: there was no `wrangler.jsonc` in this repo until
 * `vinext deploy` generated one, so ASSETS and IMAGES genuinely were undeclared
 * and `/_vinext/image` genuinely did fail. The deploy created the file, it was
 * committed, and the build's capabilities changed underneath the documentation.
 * Verify against `dist/server/wrangler.json` after a build rather than trusting
 * any comment, including this one.
 */
declare namespace Cloudflare {
  interface Env {
    /** Cloudflare D1, requested via `"d1": "DB"` in .openai/hosting.json. */
    DB: D1Database;

    /**
     * Static assets, bound by wrangler.jsonc. `worker/index.ts` uses this to
     * resolve sources for the image optimizer.
     */
    ASSETS: Fetcher;

    /** Cloudflare Images, bound by wrangler.jsonc. */
    IMAGES: unknown;

    /**
     * Cloudflare R2 — OPTIONAL, and that is not a style choice.
     *
     * `.openai/hosting.json` currently has `"r2": null`, because the account has
     * not opted into R2 (dashboard step; wrangler reports error 10042). The
     * emitted `r2_buckets` is therefore `[]` and `env.MEDIA` is UNDEFINED at
     * runtime. Typing it as present was a lie that would have thrown on the
     * first `env.MEDIA.put()` with no type error to warn anyone.
     *
     * Admin image upload cannot work until the account enables R2 and
     * hosting.json is set back to `"r2": "MEDIA"`.
     */
    MEDIA?: R2Bucket;

    /** Optional outbound webhook for appointment leads. See .env.example. */
    LEAD_WEBHOOK_URL?: string;
  }
}
