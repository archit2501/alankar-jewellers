import { SITE_DETAILS_PENDING, formattedAddress, site, whatsappUrl } from "../site-config";

/**
 * Server component — no interactivity, no client JS.
 *
 * Every value comes from `app/site-config.ts`. While `SITE_DETAILS_PENDING` is
 * true the placeholders are shown but never wired into `tel:` / `wa.me` / maps
 * links, because a dead call button converts worse than an honest "not live
 * yet" label. Flipping the single boolean in site-config turns all of them into
 * real links. That gating behaviour is unchanged by the redesign — only the
 * styling moved.
 *
 * One behavioural fix: the pending address used to be underlined with a dashed
 * rule, which is exactly what a link looks like, so people tapped it. Pending
 * values now carry no link affordance at all.
 */
export function ContactDetails() {
  const detailsPending: boolean = SITE_DETAILS_PENDING;
  const telHref = detailsPending ? null : `tel:${site.phone}`;
  const waHref = detailsPending ? null : whatsappUrl();
  const mapsHref = detailsPending || !site.mapsUrl ? null : site.mapsUrl;

  return (
    <div className="contact">
      <div className="contact__intro">
        <p className="label">Find us</p>
        <h2>Come and see them in person.</h2>
      </div>

      {detailsPending ? (
        <p className="contact__notice">
          <span className="contact__tag">Details pending</span>
          Our shop number, WhatsApp line and street address are being finalised.
          The values below are placeholders and are not yet live — please use the
          appointment request above and we will call you back.
        </p>
      ) : null}

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
              {site.phoneDisplay}
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
          <address
            className={`contact__value contact__value--address${
              detailsPending ? " contact__value--pending" : ""
            }`}
          >
            {formattedAddress()}
          </address>
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
              Directions coming soon.
            </span>
          )}
        </section>

        <section className="contact__card" aria-labelledby="contact-hours">
          <h3 className="label" id="contact-hours">
            Opening hours
          </h3>
          {/* Tabular, so this is one of the two places on the page where a
              hairline is allowed to exist. */}
          <dl className="contact__hours">
            {site.hours.map((entry) => (
              <div key={entry.days}>
                <dt>{entry.days}</dt>
                <dd>{entry.time}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
