import { formattedAddress, known, site, whatsappUrl } from "../site-config";

/**
 * Server component — no interactivity, no client JS.
 *
 * Every value comes from `app/site-config.ts`, and every value is gated on its
 * OWN `known.*` flag rather than on one shared boolean.
 *
 * That change is the whole point of this file. The shop supplied a working
 * phone number long before it supplied a street address, and under the old
 * all-or-nothing flag the live number stayed behind a dead "opening soon"
 * label — the site was hiding a fact it actually had in order to avoid
 * publishing facts it did not. Now the call and WhatsApp buttons are real
 * while the address and the opening hours are still openly unanswered.
 *
 * Two rules survive intact:
 *
 *  1. An unknown fact is never printed. Not greyed out, not dashed, not shown
 *     as a placeholder string. `site.address` still contains "Shop address
 *     line 1 / Locality / City / State / 000000" and `site.hours` still
 *     contains an assumed schedule; neither reaches the page while its flag is
 *     false, because a visitor cannot tell a styled placeholder from a real
 *     value that happens to look odd, and a wrong opening time sends someone to
 *     a closed shutter.
 *  2. Nothing unknown is given a link affordance. The pending address used to
 *     be underlined with a dashed rule, which is what a link looks like, so
 *     people tapped it.
 *
 * The one thing the pending slots gained: they can now point at a real phone
 * number, which is a far better answer than "coming soon".
 */
export function ContactDetails() {
  // Widened so both branches of every gate stay type-checked while the flags
  // in site-config are literals.
  const has: Record<keyof typeof known, boolean> = { ...known };

  const telHref = has.phone ? `tel:${site.phone}` : null;
  const waHref = has.whatsapp ? whatsappUrl() : null;
  const mapsHref = has.maps && site.mapsUrl ? site.mapsUrl : null;

  // What the visitor is still owed. Listed rather than summarised, so the
  // notice cannot go on claiming the phone line is pending after it went live.
  const outstanding = [
    has.address ? null : "a street address",
    has.hours ? null : "opening hours",
    has.email ? null : "an email address",
  ].filter((item): item is string => item !== null);

  return (
    <div className="contact">
      {/* The notice sits BESIDE the heading rather than under it: on a wide
          screen the second column of this row was otherwise empty, and a void
          next to a heading is the difference between a page that looks
          restrained and one that looks unfinished. */}
      <div className="contact__intro">
        <div>
          <h2>Come and see them in person.</h2>
        </div>

        {outstanding.length > 0 ? (
          <p className="contact__notice grained">
            <span className="contact__tag">Details pending</span>
            The phone and WhatsApp numbers below are live. Please use them.
            We have not published {listSentence(outstanding)} yet, and rather
            than print a guess we have left {outstanding.length > 1 ? "those lines" : "that line"}{" "}
            open until the shop confirms {outstanding.length > 1 ? "them" : "it"}.
          </p>
        ) : null}
      </div>

      <div className="contact__grid">
        <section className="contact__card" aria-labelledby="contact-call">
          <h3 className="label" id="contact-call">
            Call or WhatsApp
          </h3>
          {telHref ? (
            <a className="contact__value" href={telHref}>
              {site.phoneDisplay}
            </a>
          ) : (
            <span className="contact__value contact__value--pending">
              Number pending
            </span>
          )}
          <p className="contact__meta">
            Speak to the family directly, or send us a message and a photograph
            of the piece you have in mind.
          </p>
          {waHref ? (
            <a
              className="button contact__action"
              href={waHref}
              target="_blank"
              rel="noreferrer"
            >
              Message us on WhatsApp
            </a>
          ) : (
            <span className="button button--ghost contact__action contact__action--pending">
              WhatsApp opening soon
            </span>
          )}
        </section>

        <section className="contact__card" aria-labelledby="contact-address">
          <h3 className="label" id="contact-address">
            The salon
          </h3>
          {has.address ? (
            <address className="contact__value contact__value--address">
              {formattedAddress()}
            </address>
          ) : (
            /* No <address> element at all: an <address> containing an excuse is
               still an <address>, and it is a machine-readable one. */
            <p className="contact__value contact__value--address contact__value--pending">
              <span className="contact__tag">Pending</span>
              We have not published the street address yet.
            </p>
          )}
          <p className="contact__meta">
            Private viewings are held in the inner salon, away from the counter.
          </p>
          {mapsHref ? (
            <a
              className="text-action contact__action"
              href={mapsHref}
              target="_blank"
              rel="noreferrer"
            >
              Get directions
            </a>
          ) : (
            <span className="contact__meta contact__action">
              {telHref
                ? "Call or message us and we will send you the directions."
                : "Directions coming soon."}
            </span>
          )}
        </section>

        <section className="contact__card" aria-labelledby="contact-hours">
          <h3 className="label" id="contact-hours">
            Opening hours
          </h3>
          {has.hours ? (
            /* Tabular, so this is one of the two places on the page where a
               hairline is allowed to exist. */
            <dl className="contact__hours">
              {site.hours.map((entry) => (
                <div key={entry.days}>
                  <dt>{entry.days}</dt>
                  <dd>{entry.time}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <p className="contact__value contact__value--pending">
                <span className="contact__tag">Pending</span>
                Not confirmed yet.
              </p>
              <p className="contact__meta">
                The shop has not given us its hours, and an approximate one sends
                somebody to a closed shutter.{" "}
                {telHref
                  ? "Call before you set out and we will tell you when we are open."
                  : "We will publish them here as soon as they are confirmed."}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** "a, b and c" — the Oxford-free form the rest of the site's copy uses. */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
