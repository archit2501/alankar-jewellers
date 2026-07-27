import type { MetadataRoute } from "next";
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
  ];
}
