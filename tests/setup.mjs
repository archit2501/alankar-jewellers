/**
 * Test bootstrap. Loaded with `node --import ./tests/setup.mjs`.
 *
 * Redirects the `cloudflare:workers` specifier to a local stub so the built
 * Worker bundle can be imported and exercised in-process, without spinning up
 * wrangler/miniflare for what are otherwise pure request/response assertions.
 */
import { registerHooks } from "node:module";

const STUB_URL = new URL("./stubs/cloudflare-workers.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
