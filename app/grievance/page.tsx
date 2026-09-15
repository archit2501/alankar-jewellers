import type { Metadata } from "next";
import { PolicyPage } from "../_components/policy-page";
import { isPublished, policyFacts, policyKnown, policyPage } from "../_policies/facts";
import { known, site } from "../site-config";

const page = policyPage("/grievance");

export const metadata: Metadata = {
  title: `${page.title} | ${site.name}`,
  description: page.description,
  alternates: { canonical: page.href },
  robots: { index: isPublished(page), follow: true },
};

/**
 * The response times are the ones the admin panel already runs its clocks on
 * (see app/_admin/data.ts): acknowledge in forty-eight hours, resolve within a
 * month. The officer is the shop's to name, and nothing is printed until it does.
 */
export default function GrievancePage() {
  const has: Record<keyof typeof known, boolean> = { ...known };
  const officer = policyKnown.grievanceOfficer ? policyFacts.grievanceOfficer : null;

  return (
    <PolicyPage page={page} lede="How to raise a complaint, and how quickly it is answered.">
      <h2>Grievance officer</h2>
      {officer && officer.name ? (
        <p className="prose">
          {officer.name}, {officer.designation}.
          {officer.phone ? (
            <>
              {" "}
              <a href={`tel:${officer.phone}`}>{officer.phone}</a>
            </>
          ) : null}
          {officer.email ? (
            <>
              {" "}
              <a href={`mailto:${officer.email}`}>{officer.email}</a>
            </>
          ) : null}
        </p>
      ) : has.phone ? (
        <p className="prose">
          Until a grievance officer is named here, raise a complaint by phone or
          WhatsApp on <a href={`tel:${site.phone}`}>{site.phoneDisplay}</a>.
        </p>
      ) : null}

      <h2>How quickly it is answered</h2>
      <p className="prose">
        Under the Consumer Protection (E-Commerce) Rules, 2020, a complaint is
        acknowledged within forty-eight hours of being received, and resolved within
        one month.
      </p>

      <h2>If it is not resolved</h2>
      <p className="prose">
        You can also contact the National Consumer Helpline on 1915.
      </p>
    </PolicyPage>
  );
}
