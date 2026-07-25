"use client";

import { FormEvent, useEffect, useState } from "react";

const collections = [
  {
    name: "Jadau",
    image: "/images/collection-jadau.webp",
    alt: "Antique jadau necklace with uncut diamonds and emerald beads on green silk",
    copy:
      "Uncut diamonds, vivid gemstones and age-old techniques, composed as heirlooms for the next generation.",
  },
  {
    name: "Diamond",
    image: "/images/collection-diamond.webp",
    alt: "Contemporary diamond necklace arranged on deep garnet velvet",
    copy:
      "Brilliant cuts and measured lines—contemporary diamond jewellery for life’s most luminous moments.",
  },
  {
    name: "Polki",
    image: "/images/collection-polki.webp",
    alt: "Diamond polki necklace with emerald drops on a carved wooden surface",
    copy:
      "The quiet fire of uncut diamonds, set in refined silhouettes that carry India’s royal legacy forward.",
  },
];

const milestones = [
  {
    year: "1980",
    title: "A house is founded",
    copy: "With a belief that fine jewellery begins with integrity.",
  },
  {
    year: "The 1990s",
    title: "Trust grows",
    copy: "One family introduction, one cherished occasion at a time.",
  },
  {
    year: "A new generation",
    title: "The craft continues",
    copy: "Heritage techniques meet a more contemporary point of view.",
  },
  {
    year: "Today",
    title: "Heirlooms, reimagined",
    copy: "Designer pieces created to be lived in, loved and passed on.",
  },
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`brand-mark${compact ? " brand-mark--compact" : ""}`}
      href="#top"
      aria-label="Alankar Jewellers, back to top"
    >
      <span className="brand-mark__name">Alankar</span>
      <span className="brand-mark__category">Jewellers</span>
      <span className="brand-mark__since">Since 1980</span>
    </a>
  );
}

function AppointmentDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) setSubmitted(false);
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  if (!open) return null;

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="appointment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appointment-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="dialog-close" onClick={onClose} aria-label="Close">
          <span />
        </button>
        {submitted ? (
          <div className="dialog-success" aria-live="polite">
            <span className="dialog-flower" aria-hidden="true">
              ✦
            </span>
            <h2 id="appointment-title">Your private viewing begins here.</h2>
            <p>
              Thank you for sharing your preferences. Your appointment request
              has been prepared for the Alankar team.
            </p>
            <button className="button button--dark" onClick={onClose}>
              Return to the collection
            </button>
          </div>
        ) : (
          <>
            <p className="section-label">By appointment</p>
            <h2 id="appointment-title">Let us curate your private viewing.</h2>
            <p className="dialog-intro">
              Tell us what brings you to Alankar. We’ll shape the experience
              around your occasion and the pieces you hope to discover.
            </p>
            <form className="appointment-form" onSubmit={submitRequest}>
              <label>
                <span>Your name</span>
                <input name="name" autoComplete="name" required />
              </label>
              <label>
                <span>Mobile number</span>
                <input
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                />
              </label>
              <label>
                <span>I’m interested in</span>
                <select name="interest" defaultValue="Jadau and Polki">
                  <option>Jadau and Polki</option>
                  <option>Diamond jewellery</option>
                  <option>Bridal jewellery</option>
                  <option>A bespoke piece</option>
                </select>
              </label>
              <label>
                <span>Preferred time</span>
                <select name="time" defaultValue="Weekday afternoon">
                  <option>Weekday afternoon</option>
                  <option>Weekday evening</option>
                  <option>Weekend</option>
                </select>
              </label>
              <label className="form-wide">
                <span>Anything we should know?</span>
                <textarea
                  name="note"
                  rows={3}
                  placeholder="Your occasion, timeline or a piece you have in mind"
                />
              </label>
              <button className="button button--dark form-wide" type="submit">
                Prepare my request
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [appointmentOpen, setAppointmentOpen] = useState(false);

  function openAppointment() {
    setMenuOpen(false);
    setAppointmentOpen(true);
  }

  return (
    <main id="top">
      <header className="site-header">
        <BrandMark />
        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="site-navigation"
          onClick={() => setMenuOpen((value) => !value)}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
        <nav
          id="site-navigation"
          className={`site-nav${menuOpen ? " site-nav--open" : ""}`}
          aria-label="Main navigation"
        >
          <a href="#collections" onClick={() => setMenuOpen(false)}>
            Collections
          </a>
          <a href="#legacy" onClick={() => setMenuOpen(false)}>
            Our Legacy
          </a>
          <a href="#craft" onClick={() => setMenuOpen(false)}>
            Craft
          </a>
          <a href="#visit" onClick={() => setMenuOpen(false)}>
            Visit Us
          </a>
          <button className="nav-appointment" onClick={openAppointment}>
            Book an Appointment
          </button>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <img
          className="hero__image"
          src="/images/hero-jadau.webp"
          alt="Antique jadau and polki necklace displayed on a hand-carved wooden thali"
          fetchPriority="high"
        />
        <div className="hero__shade" aria-hidden="true" />
        <div className="hero__content">
          <h1 id="hero-title">
            Jewels that
            <br />
            become heirlooms.
          </h1>
          <span className="gold-rule" aria-hidden="true" />
          <p>
            Antique Jadau, Diamond and Polki. Meticulously handcrafted to be
            cherished for generations.
          </p>
          <a className="button button--light" href="#collections">
            Explore the Collections
          </a>
        </div>
        <p className="hero__promise">Serving trust since generations</p>
      </section>

      <section className="collections section-shell" id="collections">
        <div className="section-heading">
          <p className="section-label">Our collections</p>
          <h2>Three traditions. One unmistakable signature.</h2>
          <p>
            Designer pieces with a sense of history—composed by hand, made for
            the way you celebrate now.
          </p>
        </div>
        <div className="collection-list">
          {collections.map((collection, index) => (
            <article
              className={`collection collection--${index + 1}`}
              key={collection.name}
            >
              <div className="collection__frame">
                <img src={collection.image} alt={collection.alt} loading="lazy" />
              </div>
              <div className="collection__copy">
                <span>0{index + 1}</span>
                <h3>{collection.name}</h3>
                <p>{collection.copy}</p>
                <button onClick={openAppointment}>
                  Discover {collection.name}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="legacy" id="legacy" aria-labelledby="legacy-title">
        <div className="legacy__intro">
          <h2 id="legacy-title">
            Four decades.
            <br />
            <em>One promise.</em>
          </h2>
          <p>
            Since 1980, Alankar has been shaped by enduring relationships,
            exacting artistry and a simple belief: trust is the most precious
            thing we set into every jewel.
          </p>
        </div>
        <div className="timeline" aria-label="Alankar Jewellers legacy">
          {milestones.map((milestone) => (
            <article className="timeline__item" key={milestone.year}>
              <span className="timeline__dot" aria-hidden="true" />
              <p className="timeline__year">{milestone.year}</p>
              <h3>{milestone.title}</h3>
              <p>{milestone.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="craft section-shell" id="craft">
        <div className="craft__copy">
          <p className="section-label">Heritage + craft</p>
          <h2>
            Made slowly.
            <br />
            <em>Worn forever.</em>
          </h2>
          <span className="gold-rule gold-rule--dark" aria-hidden="true" />
          <p>
            Every Alankar jewel begins at the bench. Stones are studied,
            selected and set by hand, with the patience that antique Jadau and
            Polki demand.
          </p>
          <p>
            It is a dialogue between designer and artisan—between an old
            technique and the life the jewel will enter.
          </p>
          <button className="text-action" onClick={openAppointment}>
            Begin a bespoke conversation
          </button>
        </div>
        <figure className="craft__image">
          <img
            src="/images/artisan-setting.webp"
            alt="Master artisan hand-setting an uncut diamond into a jadau jewel"
            loading="lazy"
          />
          <figcaption>
            Hand-set in the tradition of India’s great ateliers.
          </figcaption>
        </figure>
      </section>

      <section className="appointment" id="visit">
        <div className="appointment__media">
          <img
            src="/images/private-salon.webp"
            alt="Private jewellery salon in a restored Indian haveli"
            loading="lazy"
          />
        </div>
        <div className="appointment__copy">
          <p className="section-label section-label--gold">By appointment</p>
          <h2>
            A private experience,
            <br />
            crafted around <em>you.</em>
          </h2>
          <span className="gold-rule" aria-hidden="true" />
          <p>
            Discover the collections at your own pace, guided by someone who
            understands the jewel, the craft and the occasion it will become a
            part of.
          </p>
          <button className="button button--light" onClick={openAppointment}>
            Book an Appointment
          </button>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer__brand">
          <BrandMark compact />
          <p>Serving trust since generations.</p>
        </div>
        <div className="footer__column">
          <p>Collections</p>
          <a href="#collections">Jadau</a>
          <a href="#collections">Diamond</a>
          <a href="#collections">Polki</a>
        </div>
        <div className="footer__column">
          <p>Alankar</p>
          <a href="#legacy">Our Legacy</a>
          <a href="#craft">The Art of Craft</a>
          <button onClick={openAppointment}>Private Appointments</button>
        </div>
        <div className="footer__closing">
          <p>Antique heritage. Timeless craftsmanship.</p>
          <small>© {new Date().getFullYear()} Alankar Jewellers.</small>
        </div>
      </footer>

      <AppointmentDialog
        open={appointmentOpen}
        onClose={() => setAppointmentOpen(false)}
      />
    </main>
  );
}
