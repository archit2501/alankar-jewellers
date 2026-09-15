import type { Metadata } from "next";
import { PolicyPage } from "../_components/policy-page";
import { isPublished, policyFacts, policyKnown, policyPage } from "../_policies/facts";
import { site } from "../site-config";

const page = policyPage("/returns");

export const metadata: Metadata = {
  title: `${page.title} | ${site.name}`,
  description: page.description,
  alternates: { canonical: page.href },
  robots: { index: isPublished(page), follow: true },
};

function Paragraphs({ items }: { items: readonly string[] }) {
  return (
    <>
      {items.map((paragraph) => (
        <p className="prose" key={paragraph}>
          {paragraph}
        </p>
      ))}
    </>
  );
}

/** Deliberately almost empty: returns and exchange are the shop's decision. */
export default function ReturnsPage() {
  return (
    <PolicyPage
      page={page}
      lede="Returns, exchanges and refunds for pieces bought from Alankar Jewellers."
    >
      <h2>Payments made here</h2>
      <p className="prose">
        No payment is taken on this website yet, so there is no online payment to
        refund.
      </p>

      {policyKnown.returns && policyFacts.returns.length > 0 ? (
        <>
          <h2>Returns</h2>
          <Paragraphs items={policyFacts.returns} />
        </>
      ) : null}

      {policyKnown.exchange && policyFacts.exchange.length > 0 ? (
        <>
          <h2>Exchange and buyback</h2>
          <Paragraphs items={policyFacts.exchange} />
        </>
      ) : null}

      {policyKnown.cancellation && policyFacts.cancellation.length > 0 ? (
        <>
          <h2>Cancelling an order</h2>
          <Paragraphs items={policyFacts.cancellation} />
        </>
      ) : null}
    </PolicyPage>
  );
}
