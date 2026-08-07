import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

/**
 * Real Cloudflare resource identity, for deploying to our own account.
 *
 * Local development does not need any of this: Miniflare simulates D1 and R2
 * from the binding NAMES alone, and the placeholder database id above is fine
 * because nothing is talking to Cloudflare. A real `vinext deploy` is different
 * -- it needs the actual database id, or the Worker binds to nothing and every
 * enquiry is lost at runtime rather than at build time.
 *
 * These are identifiers, not secrets (a D1 id is useless without an account
 * token), so they are committed rather than hidden in a .env that would be
 * missing on someone else's machine and fail silently.
 */
const D1_DATABASE_NAME = process.env.CF_D1_NAME ?? "alankar-jewellers";
const D1_DATABASE_ID =
  process.env.CF_D1_ID ?? "f32f8f79-4bc7-4741-b860-121eda943779";
const R2_BUCKET_NAME = process.env.CF_R2_BUCKET ?? "alankar-jewellers-media";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: D1_DATABASE_NAME,
          database_id: D1_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: R2_BUCKET_NAME,
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // Static design preview only. A GitHub Pages project site is served from
  // /<repo>/, so emitted asset URLs need that prefix. Vite's `base` does this
  // WITHOUT touching routing — Next's `basePath` also rewrites routes, which
  // makes vinext classify both pages as dynamic and refuse to prerender them.
  // Unset for the real Cloudflare deployment, which serves from a domain root.
  const previewBase = process.env.PREVIEW_BASE_PATH?.trim();

  return {
    base: previewBase ? `${previewBase}/` : "/",
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
