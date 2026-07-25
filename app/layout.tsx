import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alankar Jewellers | Jadau, Diamond & Polki Since 1980",
  description:
    "Alankar Jewellers has crafted antique Jadau, diamond and Polki jewellery since 1980. Designer pieces, made with trust and artistry across generations.",
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
  },
  openGraph: {
    title: "Alankar Jewellers | Since 1980",
    description:
      "Jewels that become heirlooms. Antique Jadau, Diamond and Polki, crafted with trust across generations.",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "Alankar Jewellers — Jewels that become heirlooms",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Alankar Jewellers | Since 1980",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
