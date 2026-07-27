import type { MetadataRoute } from "next";
import { site } from "./site-config";

/** Served at /robots.txt via the Next.js metadata file convention. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The appointment endpoint is a POST target, not a page.
        disallow: "/api/",
      },
    ],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
