"use client";

import { useEffect, useRef, useState } from "react";
import { AppointmentTrigger } from "./appointment";
import { BrandMark } from "./brand-mark";

/** Page order, so the nav reads as a table of contents rather than a menu. */
const NAV_LINKS = [
  { href: "#collections", label: "The pieces" },
  { href: "#reverse", label: "The reverse" },
  { href: "#craft", label: "Craft" },
  { href: "#visit", label: "Visit" },
  { href: "/shop", label: "The shop" },
  { href: "/founders", label: "The people" },
];

export function SiteHeader() {
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
    // this identity most wants to avoid — it reads as a web border.
    <header className="site-header grained">
      <div className="site-header__inner">
        <BrandMark />
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
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </a>
          ))}
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
