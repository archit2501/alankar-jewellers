import Link from "next/link";
import { POLICY_PAGES } from "../_policies/facts";

/**
 * Links to every policy page, from every storefront footer. A policy a visitor
 * cannot find from the page they are buying on might as well not exist, which
 * is why tests/policies.test.mjs checks each storefront route for all of them.
 *
 * Linked even while a page is still waiting on the shop: the page itself says
 * what is outstanding, which is more useful than a missing link.
 */
export function PolicyLinks({ inline = false }: { inline?: boolean }) {
  const links = POLICY_PAGES.map((page) => (
    <Link href={page.href} key={page.href}>
      {page.title}
    </Link>
  ));
  if (!inline) return <>{links}</>;
  return (
    <nav className="policy-links" aria-label="Policies">
      {links}
    </nav>
  );
}
