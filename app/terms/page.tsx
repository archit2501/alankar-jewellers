import type { Metadata } from "next";
import { PolicyPage } from "../_components/policy-page";
import { isPublished, policyFacts, policyKnown, policyPage } from "../_policies/facts";
import { site } from "../site-config";

const page = policyPage("/terms");

export const metadata: Metadata = {
  title: `${page.title} | ${site.name}`,
  description: page.description,
  alternates: { canonical: page.href },
  robots: { index: isPublished(page), follow: true },
};

/** Only what the storefront and checkout already do. The shop supplies the rest. */
export default function TermsPage() {
  return (
    <PolicyPage
      page={page}
      lede="How pieces on this website are priced, and what placing an order here does and does not do."
    >
      <h2>Prices</h2>
      <p className="prose">
        A piece marked price on request has no price on this website. Ask the shop for
        it.
      </p>
      <p className="prose">
        A piece shown with a price is priced from the IBJA gold rate for its purity,
        plus its making charge, the value of any stones, hallmarking where it applies,
        and GST at 3%. If the day&rsquo;s rate has not been confirmed, no price is shown
        at all rather than an old one.
      </p>

      <h2>Demonstration pieces</h2>
      <p className="prose">
        Pieces labelled as a demonstration do not physically exist. Their weights and
        making charges are invented to show how pricing works, and a total shown for
        one is not a quotation.
      </p>

      <h2>Placing an order</h2>
      <p className="prose">
        No payment is taken on this website. An order placed here records the pieces,
        the price at that moment and your details, and waits for payment to be arranged
        with the shop.
      </p>
      {policyKnown.paymentMethods && policyFacts.paymentMethods.length > 0
        ? policyFacts.paymentMethods.map((paragraph) => (
            <p className="prose" key={paragraph}>
              {paragraph}
            </p>
          ))
        : null}

      <h2>Hallmarking</h2>
      <p className="prose">
        Plain gold jewellery must carry a BIS hallmark when it is sold. Kundan, Polki
        and Jadau work is exempt from mandatory hallmarking.
      </p>

      {policyKnown.cancellation && policyFacts.cancellation.length > 0 ? (
        <>
          <h2>Cancellation</h2>
          {policyFacts.cancellation.map((paragraph) => (
            <p className="prose" key={paragraph}>
              {paragraph}
            </p>
          ))}
        </>
      ) : null}

      {policyKnown.gstin && policyFacts.gstin ? (
        <p className="prose">
          {site.name} is registered for GST under GSTIN {policyFacts.gstin}.
        </p>
      ) : null}
    </PolicyPage>
  );
}
