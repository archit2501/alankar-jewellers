/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { ingestRateQuotes, readIbjaRates } from "../app/_pricing/rates";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/**
 * SECURITY HEADERS, ON EVERY RESPONSE THE WORKER PRODUCES.
 *
 * Before this the storefront sent none, and `/admin` could be loaded inside
 * another site's frame: a sign-in form that a hostile page can overlay and
 * click-jack. Set here, once, so a page added next year inherits them instead
 * of depending on someone remembering.
 *
 * WHAT THIS DOES NOT COVER: static files. Cloudflare serves `dist/client`
 * before this script runs, so images, fonts and bundles get their headers from
 * `public/_headers` instead.
 *
 * ONLY WHERE ABSENT. The admin already sends a stricter
 * `Referrer-Policy: same-origin`; overwriting it with the storefront default
 * would weaken the one surface that most needs it.
 *
 * THE CSP IS DELIBERATELY NARROW. No `script-src`: the framework hydrates with
 * inline scripts, and a script policy without nonces would either break the
 * page or need 'unsafe-inline', which defeats the point. What IS pinned costs
 * nothing: no framing, no <base> hijack, no plugins, and forms may only post
 * back to this origin, which every form on the site already does.
 *
 * `payment=()` will need revisiting when a payment gateway is added, if its
 * checkout uses the Payment Request API.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  [
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  ],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
];

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  let changed = false;
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) {
      headers.set(name, value);
      changed = true;
    }
  }
  if (!changed) return response;
  // Framework responses can carry immutable headers, so build a new Response
  // rather than mutating in place. The body stream is passed through untouched.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withSecurityHeaders(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },

  /**
   * THE GOLD RATE INGEST. Cron schedule lives in `wrangler.jsonc`.
   *
   * ---------------------------------------------------------------------
   * WHY THERE ARE THREE RUNS AND NOT ONE
   * ---------------------------------------------------------------------
   * IBJA polls the spot market 11:30–12:00 and 16:30–17:00 and displays the
   * result "at around 12:05 PM and 5:05 PM on all business days". Those two
   * moments are the only times a new figure exists. Everything else is a
   * re-read of something already published.
   *
   * A rate expires when the NEXT publication was due and did not arrive, plus
   * 90 minutes of grace (see RATE_STALE_GRACE_MINUTES). So yesterday evening's
   * rate dies at 13:35 IST today. A job that only ran at 10:00 IST would
   * therefore find nothing new to fetch, and the storefront would sit unpriced
   * from 13:35 until the following morning — roughly twenty-one hours a day,
   * every day, including the whole of trading afternoon.
   *
   * The two runs just after each publication are what actually keep the site
   * priced. The 10:00 run is kept because it is genuinely useful for a
   * different reason: it re-checks before the shop opens, so a feed that broke
   * overnight is visible on the Today screen at opening rather than discovered
   * by a customer at lunchtime.
   *
   * ---------------------------------------------------------------------
   * WHY THIS CALLS THE FUNCTIONS AND NOT ITS OWN HTTP ENDPOINT
   * ---------------------------------------------------------------------
   * POST /api/gold-rate does the same work, but it is guarded by a shared
   * secret because it is reachable from the internet. A cron running INSIDE
   * this Worker needs no such guard, so routing through HTTP would mean
   * provisioning a secret, storing it, and giving the schedule a public
   * attack surface it does not otherwise have. The endpoint stays for manual
   * and dry-run use.
   *
   * FAILURE IS DELIBERATELY QUIET AND FAIL-CLOSED. If IBJA is unreachable or
   * its markup has changed, nothing is written, the previous rate stands until
   * it expires on the slot rule, and the storefront then refuses to quote
   * rather than pricing against a stale figure. A thrown error here would only
   * mark the cron invocation failed; the storefront behaviour is identical
   * either way, and it is already the correct behaviour.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ingestCurrentRate(controller.scheduledTime));
  },
};

/**
 * Read IBJA and write whatever is current. Idempotent by construction: the
 * quotes are stored against `slotRef`, IBJA's publication slot, so the 10:00
 * run re-reading the previous evening's figures writes the same slot it wrote
 * yesterday rather than inventing a new one.
 */
async function ingestCurrentRate(scheduledTime: number): Promise<void> {
  const read = await readIbjaRates(scheduledTime);
  if (!read.ok) {
    console.warn(`[rate-cron] could not read IBJA: ${read.message}`);
    return;
  }

  const result = await ingestRateQuotes(read.reading.quotes, {
    source: "ibja",
    sourceRef: read.reading.slotRef,
    effectiveFrom: read.reading.effectiveFrom,
    createdBy: null,
  });

  if (!result.ok) {
    console.warn(`[rate-cron] could not store the rate: ${result.message}`);
    return;
  }

  console.log(`[rate-cron] ${read.reading.slotRef}: ${result.inserted} quote(s) stored`);
}

export default worker;
