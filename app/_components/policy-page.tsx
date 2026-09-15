import Link from "next/link";
import type { ReactNode } from "react";
import { PENDING, outstanding, type PolicyPageMeta } from "../_policies/facts";
import { known, site } from "../site-config";
import { AppointmentProvider } from "./appointment";
import { PolicyLinks } from "./policy-links";
import { SiteHeader } from "./site-header";

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The shell every policy page shares. The notice at the top is generated from
 * the facts the page depends on, so it cannot go on claiming something is
 * missing after the shop has supplied it, and it disappears once nothing is.
 */
export function PolicyPage({
  page,
  lede,
  children,
}: {
  page: PolicyPageMeta;
  lede: string;
  children: ReactNode;
}) {
  const missing = outstanding(page);
  // Widened so both branches stay type-checked while the flags are literals.
  const has: Record<keyof typeof known, boolean> = { ...known };

  return (
    <AppointmentProvider>
      <div className="policy-page">
        <SiteHeader current="policy" />
        <main>
          <section
            className="section section--haveli grained policy"
            aria-labelledby="policy-title"
          >
            <div className="wrap policy__inner">
              <h1 id="policy-title">{page.title}</h1>
              <p className="lede policy__lede">{lede}</p>

              {missing.length > 0 ? (
                <aside className="policy-pending" aria-label="Not yet published">
                  <p>
                    <strong>Not yet published in full.</strong> The shop has still to
                    supply {joinList(missing.map((fact) => PENDING[fact]))}. Until it
                    does, this page states only what is already true of this website.
                  </p>
                  {has.phone ? (
                    <p>
                      Ask the shop directly on{" "}
                      <a href={`tel:${site.phone}`}>{site.phoneDisplay}</a>.
                    </p>
                  ) : null}
                </aside>
              ) : null}

              {children}
            </div>
          </section>
        </main>

        <footer className="policy-colophon section--darbar-deep grained">
          <div className="wrap">
            <p>
              {site.name}, since {site.foundedYear}.{" "}
              <Link href="/">Back to the shop</Link>
            </p>
            <PolicyLinks inline />
          </div>
        </footer>
      </div>
    </AppointmentProvider>
  );
}
