import type { Metadata } from "next";
import { PolicyPage } from "../_components/policy-page";
import {
  CHECKOUT_DATA,
  COOKIE_FACTS,
  ENQUIRY_DATA,
  isPublished,
  policyFacts,
  policyKnown,
  policyPage,
} from "../_policies/facts";
import { formattedAddress, known, site } from "../site-config";

const page = policyPage("/privacy");

export const metadata: Metadata = {
  title: `${page.title} | ${site.name}`,
  description: page.description,
  alternates: { canonical: page.href },
  // Indexed only once every fact it depends on has been supplied.
  robots: { index: isPublished(page), follow: true },
};

/**
 * Every data statement here is read off the code, and tests/policies.test.mjs
 * parses that code: a checkout field, an enquiry column or a cookie that this
 * page does not describe fails CI. If LEAD_WEBHOOK_URL is ever configured, this
 * page must say where enquiries are forwarded before that goes live.
 */
export default function PrivacyPage() {
  const has: Record<keyof typeof known, boolean> = { ...known };
  const dataEmail = policyKnown.dataContact ? policyFacts.dataContactEmail : null;

  return (
    <PolicyPage
      page={page}
      lede="What this website collects, why, where it is kept, and what you can ask for. It describes what the site actually does today."
    >
      <h2>Who is responsible</h2>
      <p className="prose">
        {site.name} decides what happens to the personal data collected through this
        website.
        {has.address ? ` Its address is ${formattedAddress()}.` : null}
      </p>

      <h2>When you ask for an appointment</h2>
      <ul className="policy__list">
        {ENQUIRY_DATA.map((entry) => (
          <li key={entry.item}>
            <strong>{entry.item}</strong>: {entry.why}.
          </li>
        ))}
      </ul>

      <h2>When you place an order</h2>
      <ul className="policy__list">
        {CHECKOUT_DATA.map((entry) => (
          <li key={entry.item}>
            <strong>{entry.item}</strong>: {entry.why}.
          </li>
        ))}
      </ul>
      <p className="prose">
        No card, bank or payment details are taken on this website, and no payment is
        collected here.
      </p>

      <h2>Cookies</h2>
      <ul className="policy__list">
        <li>
          <strong>{COOKIE_FACTS.cart.name}</strong>: remembers what is in your cart. It
          holds a random identifier rather than your name, lasts {COOKIE_FACTS.cart.days}{" "}
          days, and no script on the page can read it.
        </li>
        <li>
          <strong>{COOKIE_FACTS.admin.name}</strong>: set only for the shop staff when
          they sign in to manage the shop. It signs them out after{" "}
          {COOKIE_FACTS.admin.idleHours} hours without use, and after{" "}
          {COOKIE_FACTS.admin.absoluteDays} days at most.
        </li>
      </ul>
      <p className="prose">
        There are no advertising or analytics cookies, and no tracking scripts from
        other companies. Fonts and photographs are served from this website itself.
      </p>

      <h2>Where it is kept, and who sees it</h2>
      <p className="prose">
        This website and its database are hosted by Cloudflare, on infrastructure
        outside India. Your details are seen by the shop, and every time a staff
        account opens a customer record, that is logged.
      </p>
      <p className="prose">
        The day&rsquo;s gold rate is fetched from IBJA, and nothing about you is sent
        with that request. A WhatsApp link opens WhatsApp only when you choose to tap
        it.
      </p>

      <h2>How long it is kept</h2>
      {policyKnown.retention && policyFacts.retention.length > 0 ? (
        policyFacts.retention.map((paragraph) => (
          <p className="prose" key={paragraph}>
            {paragraph}
          </p>
        ))
      ) : (
        <p className="prose">
          The shop has not yet set how long order, customer and enquiry records are
          kept. Until it does, none of them is deleted automatically.
        </p>
      )}

      <h2>What you can ask for</h2>
      <p className="prose">
        Under the Digital Personal Data Protection Act, 2023, you can ask what personal
        data is held about you, have it corrected or erased, have a complaint about it
        answered, and nominate someone to act for you. The Act also lets you take an
        unresolved complaint to the Data Protection Board of India.
      </p>
      <p className="prose">
        {dataEmail ? (
          <>
            Write to <a href={`mailto:${dataEmail}`}>{dataEmail}</a>
            {has.phone ? (
              <>
                , or call <a href={`tel:${site.phone}`}>{site.phoneDisplay}</a>
              </>
            ) : null}
            .
          </>
        ) : has.phone ? (
          <>
            For now, ask by phone or WhatsApp on{" "}
            <a href={`tel:${site.phone}`}>{site.phoneDisplay}</a>.
          </>
        ) : null}
      </p>
    </PolicyPage>
  );
}
