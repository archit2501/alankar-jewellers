import type { MetadataRoute } from "next";

import { CATALOGUE_SEED } from "./_data/catalogue";
import { site } from "./site-config";

/**
 * Served at /sitemap.xml via the Next.js metadata file convention.
 * Add an entry here for every new route.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${site.url}/`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${site.url}/founders`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.6,
    },
    {
      url: `${site.url}/shop`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    // One entry per piece. Read from the seed rather than from D1: a sitemap
    // that throws when the database is briefly unreachable is worse than one
    // that is briefly stale, and this route has no other reason to touch D1.
    // Filtered listing views are deliberately absent -- they are noindex, and a
    // four-way facet product over a handful of pieces is duplicate content.
    ...CATALOGUE_SEED.map((piece) => ({
      url: `${site.url}/shop/${piece.slug}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
