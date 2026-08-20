"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AppointmentTrigger } from "./appointment";
import { BrandMark } from "./brand-mark";

/**
 * THE ONE COURT BAND, FOR EVERY STOREFRONT ROUTE.
 *
 * There were six of these. The homepage had this component; /shop, /shop/[slug],
 * /cart, /checkout and /founders each carried a hand-copied `*-topbar` that was
 * the same markup under a different class prefix, with the nav items, the
 * wordmark colour and the aria-current convention drifting apart at every copy.
 * A visitor reads that as a different website, which is the opposite of what a
 * house trading on continuity since 1980 can afford.
 *
 * Two things that drift had actually broken, and that this fixes:
 *
 *   1. NOTHING LINKED TO THE CART. Not one storefront page served an
 *      `href="/cart"` in its header. A visitor who added a piece to the bag had
 *      the browser back button and nothing else. The bag is now a permanent
 *      item in the nav on every route, and the band is sticky, so it is
 *      reachable from anywhere on any page.
 *   2. "The shop" MEANT TWO PLACES. On the homepage it pointed at /shop. On the
 *      other five it was the label for the link back to /. Meanwhile /shop
 *      itself was called "The catalogue" in three headers and "All pieces" in a
 *      fourth. One destination, one label, everywhere.
 *
 * The count is deliberately DOWN by one despite the cart being added. The nav
 * already had to collapse to a hamburger at 1100px with six items, so the
 * `#collections` teaser folded into "The pieces" (it was a homepage preview of
 * the catalogue the link now goes to) and `#visit` came out, because "Book an
 * Appointment" beside it is the same request with a form attached.
 */
export type SiteHeaderRoute =
  | "home"
  | "shop"
  | "pdp"
  | "cart"
  | "checkout"
  | "founders";

/**
 * `current` lists the routes on which an item is the page you are already on.
 * The catalogue owns the product pages beneath it, so a PDP marks "The pieces".
 * Checkout deliberately marks nothing: it is a step, not a destination, and
 * marking the bag as current there would say you are looking at the bag.
 */
const NAV_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  current: ReadonlyArray<SiteHeaderRoute>;
}> = [
  { href: "/shop", label: "The pieces", current: ["shop", "pdp"] },
  { href: "/#reverse", label: "The reverse", current: [] },
  { href: "/#craft", label: "The craft", current: [] },
  { href: "/founders", label: "The people", current: ["founders"] },
  { href: "/cart", label: "Your cart", current: ["cart"] },
];

export function SiteHeader({ current }: { current: SiteHeaderRoute }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  // The overlay covers the viewport, so the page behind it must not scroll.
  // The dialog already did this; the menu never did.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  return (
    // The court band. It carries a doubled gold rule along its bottom edge
    // rather than a 1px divider, because a single hairline of gold is the thing
    // this identity most wants to avoid: it reads as a web border.
    <header className="site-header grained">
      <div className="site-header__inner">
        <BrandMark href={current === "home" ? "#top" : "/"} />
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="site-navigation"
          ref={toggleRef}
          onClick={() => setMenuOpen((value) => !value)}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
        <nav
          id="site-navigation"
          className={`site-nav${menuOpen ? " site-nav--open" : ""}`}
          aria-label="Main navigation"
        >
          {NAV_LINKS.map((link) =>
            // A fragment is a scroll, not a route, so it stays a plain anchor:
            // `/#craft` from /cart is a real navigation, and from / it is the
            // same-document jump it has always been. Everything else is a route
            // change and gets the router.
            link.href.includes("#") ? (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                aria-current={
                  link.current.includes(current) ? "page" : undefined
                }
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            ),
          )}
          <AppointmentTrigger
            className="nav-appointment"
            onActivate={() => setMenuOpen(false)}
          >
            Book an Appointment
          </AppointmentTrigger>
        </nav>
      </div>
      <div className="rule-gold" aria-hidden="true" />
    </header>
  );
}
