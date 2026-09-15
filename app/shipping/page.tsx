import type { Metadata } from "next";
import { PolicyPage } from "../_components/policy-page";
import { isPublished, policyFacts, policyKnown, policyPage } from "../_policies/facts";
import { site } from "../site-config";

const page = policyPage("/shipping");

export const metadata: Metadata = {
  title: `${page.title} | ${site.name}`,
  description: page.description,
  alternates: { canonical: page.href },
  robots: { index: isPublished(page), follow: true },
};

/** Restates what checkout already tells a customer, and nothing more. */
export default function ShippingPage() {
  return (
    <PolicyPage page={page} lede="Collecting a piece from the shop, or having it sent to you.">
      <h2>Collecting it from the shop</h2>
      <p className="prose">
        You can choose to collect a piece from the shop, where it is handed over across
        the counter.
      </p>

      <h2>Having it sent</h2>
      <p className="prose">
        Ordinary couriers do not carry jewellery, so carriage is arranged and insured
        by hand. It is agreed with you before anything leaves the shop, and nothing is
        charged for it at checkout.
      </p>
      <p className="prose">
        A piece that is sent has to be paid for in full. Booking a piece with an
        advance is for pieces collected from the shop.
      </p>

      {policyKnown.deliveryTerms && policyFacts.deliveryTerms.length > 0
        ? policyFacts.deliveryTerms.map((paragraph) => (
            <p className="prose" key={paragraph}>
              {paragraph}
            </p>
          ))
        : null}
    </PolicyPage>
  );
}
