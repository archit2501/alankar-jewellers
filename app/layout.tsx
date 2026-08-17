import type { Metadata } from "next";
import "./globals.css";
import { jewelryStoreJsonLd, serializeJsonLd } from "./_seo/structured-data";
import { site } from "./site-config";

const title = `${site.name} | Jadau, Diamond & Polki Since ${site.foundedYear}`;
const description =
  "Alankar Jewellers has crafted antique Jadau, diamond and Polki jewellery since 1980. Designer pieces, made with trust and artistry across generations.";
const socialTitle = `${site.name} | Since ${site.foundedYear}`;

export const metadata: Metadata = {
  // Without this every og:image / canonical resolves relative, and WhatsApp,
  // Facebook, LinkedIn and X all silently drop the preview image.
  metadataBase: new URL(site.url),
  title,
  description,
  applicationName: site.name,
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
  },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: "/",
    siteName: site.name,
    title: socialTitle,
    description:
      "Jewels that become heirlooms. Antique Jadau, Diamond and Polki, crafted with trust across generations.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Alankar Jewellers. Jewels that become heirlooms",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description:
      "Jewels that become heirlooms. Antique Jadau, Diamond and Polki.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-IN">
      <body>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd(jewelryStoreJsonLd()),
          }}
        />
      </body>
    </html>
  );
}
