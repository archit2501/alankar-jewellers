"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import { known, site, whatsappUrl } from "../site-config";

export const INTEREST_OPTIONS = [
  "Jadau and Polki",
  "Diamond jewellery",
  "Bridal jewellery",
  "A bespoke piece",
] as const;

export type Interest = (typeof INTEREST_OPTIONS)[number];

const DEFAULT_INTEREST: Interest = "Jadau and Polki";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Gated per fact, like the rest of the site: the phone and WhatsApp lines are
 *  verified, so the fallback shown when the form fails is a route that actually
 *  works. Widened to `boolean` so both branches stay type-checked while the
 *  flags in site-config are literals. */
const has: Record<keyof typeof known, boolean> = { ...known };
const telHref = has.phone ? `tel:${site.phone}` : null;
const waHref = has.whatsapp ? whatsappUrl() : null;

type OpenAppointment = (
  interest?: Interest,
  trigger?: HTMLElement | null,
) => void;

const AppointmentContext = createContext<OpenAppointment | null>(null);

export function useAppointment(): OpenAppointment {
  const open = useContext(AppointmentContext);
  if (!open) {
    throw new Error("useAppointment must be used inside <AppointmentProvider>");
  }
  return open;
}

/**
 * Client island that owns the appointment dialog. Everything passed as
 * `children` is rendered on the server and simply forwarded, so wrapping the
 * page in this provider costs no extra client JavaScript for the static
 * sections.
 */
export function AppointmentProvider({ children }: { children: ReactNode }) {
  const [interest, setInterest] = useState<Interest | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback<OpenAppointment>((nextInterest, trigger) => {
    triggerRef.current = trigger ?? null;
    setInterest(nextInterest ?? DEFAULT_INTEREST);
  }, []);

  const close = useCallback(() => setInterest(null), []);

  // Runs as the dialog unmounts, i.e. after React has removed the focused
  // node, which is why focus lands back on the trigger instead of <body>.
  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger && trigger.isConnected) trigger.focus();
  }, []);

  const value = useMemo(() => open, [open]);

  return (
    <AppointmentContext.Provider value={value}>
      {children}
      {interest !== null ? (
        <AppointmentDialog
          interest={interest}
          onClose={close}
          restoreFocus={restoreFocus}
        />
      ) : null}
    </AppointmentContext.Provider>
  );
}

export function AppointmentTrigger({
  children,
  className,
  interest,
  onActivate,
}: {
  children: ReactNode;
  className?: string;
  interest?: Interest;
  onActivate?: () => void;
}) {
  const open = useAppointment();
  return (
    <button
      type="button"
      className={className}
      onClick={(event) => {
        onActivate?.();
        open(interest, event.currentTarget);
      }}
    >
      {children}
    </button>
  );
}

type Status = "idle" | "pending" | "error" | "success" | "preview";

type AppointmentResponse = { ok?: boolean; error?: string };

const GENERIC_ERROR =
  "We could not send your request just now. Please try again in a moment.";

/**
 * The design preview published to GitHub Pages is a STATIC export: there is no
 * server behind it, so `POST /api/appointments` does not exist there and a
 * visitor pressing "Send request" would get a 404 and read a failure message
 * about a system that is in fact working fine.
 *
 * The preview therefore says plainly what it is, rather than pretending to
 * submit or pretending to fail. Keyed on the Pages hostname, so the real
 * deployment is completely unaffected and no build flag has to be threaded
 * through vinext.
 */
function isStaticPreview() {
  return (
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(".github.io")
  );
}

const PREVIEW_NOTICE =
  "This is a design preview, so the booking form is not connected here. On the live site this request reaches the shop directly.";

function AppointmentDialog({
  interest,
  onClose,
  restoreFocus,
}: {
  interest: Interest;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open, hand it back to the trigger on close.
  useEffect(() => {
    const target = firstFieldRef.current ?? dialogRef.current;
    target?.focus();
    return restoreFocus;
  }, [restoreFocus]);

  // Submitting disables the button (and the success screen replaces the form
  // outright), so focus has to be re-homed rather than dropped onto <body>.
  useEffect(() => {
    if (status === "success") successRef.current?.focus();
    else if (status === "error" || status === "preview") errorRef.current?.focus();
  }, [status]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape to close plus a real focus trap. Both listeners are mounted only
  // while the dialog itself is mounted.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          element.tabIndex >= 0 && element.getClientRects().length > 0,
      );

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);

      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "pending") return;

    const data = new FormData(event.currentTarget);
    setStatus("pending");
    setError(null);

    if (isStaticPreview()) {
      setStatus("preview");
      return;
    }

    let payload: AppointmentResponse | null = null;
    let ok = false;

    try {
      const response = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(data.get("name") ?? ""),
          phone: String(data.get("phone") ?? ""),
          interest: String(data.get("interest") ?? ""),
          time: String(data.get("time") ?? ""),
          note: String(data.get("note") ?? ""),
          company: String(data.get("company") ?? ""),
        }),
      });
      payload = (await response
        .json()
        .catch(() => null)) as AppointmentResponse | null;
      ok = response.ok && payload?.ok === true;
    } catch {
      ok = false;
    }

    if (!ok) {
      setStatus("error");
      setError(payload?.error ?? GENERIC_ERROR);
      return;
    }

    setStatus("success");
  }

  const pending = status === "pending";

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="appointment-dialog grained"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appointment-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* 44px, the minimum touch target. The previous close control was 42px
            and drew its X from pseudo-elements pinned at hardcoded offsets that
            only centred at exactly that size, around an empty <span />. */}
        <button
          type="button"
          className="dialog-close"
          onClick={onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              d="M4 4l12 12M16 4L4 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {/* The manuscript page: illuminated brass brackets on the panel, and the
            grain on the sheet behind it. */}
        <div className="appointment-dialog__inner illuminated illuminated--brass">
          {status === "success" ? (
          <div className="dialog-success">
            <span className="dialog-mark" aria-hidden="true">
              ✦
            </span>
            <h2 id="appointment-title" tabIndex={-1} ref={successRef}>
              Your private viewing begins here.
            </h2>
            <p>
              Thank you for sharing your preferences. Your appointment request
              has reached the Alankar team, and we will confirm your time by
              phone.
            </p>
            <button type="button" className="button" onClick={onClose}>
              Return to the collection
            </button>
          </div>
        ) : (
          <>
            <p className="label">By appointment</p>
            <h2 id="appointment-title">Let us curate your private viewing.</h2>
            <p className="dialog-intro">
              Tell us what brings you to Alankar. We’ll shape the experience
              around your occasion and the pieces you hope to discover.
            </p>
            <form
              className="appointment-form"
              onSubmit={submitRequest}
              aria-busy={pending}
            >
              <label>
                <span>Your name</span>
                <input
                  name="name"
                  autoComplete="name"
                  required
                  ref={firstFieldRef}
                />
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
                <select name="interest" defaultValue={interest}>
                  {INTEREST_OPTIONS.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
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

              {/* Honeypot: real people never see it, never tab to it and never fill it. */}
              <div className="visually-hidden" aria-hidden="true">
                <label htmlFor="appointment-company">
                  Company (leave this empty)
                </label>
                <input
                  id="appointment-company"
                  name="company"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  defaultValue=""
                />
              </div>

              {status === "preview" ? (
                <div
                  className="form-note form-wide"
                  role="status"
                  tabIndex={-1}
                  ref={errorRef}
                >
                  <strong>Design preview</strong>
                  <span>{PREVIEW_NOTICE}</span>
                </div>
              ) : null}

              {error ? (
                <div
                  className="form-error form-wide"
                  role="alert"
                  tabIndex={-1}
                  ref={errorRef}
                >
                  <strong>We couldn’t send that.</strong>
                  <span>{error}</span>
                  <span className="form-error__fallback">
                    {telHref ? (
                      <a href={telHref}>Call {site.phoneDisplay}</a>
                    ) : (
                      <span>Phone line publishing soon</span>
                    )}
                    {waHref ? (
                      <a href={waHref} target="_blank" rel="noreferrer">
                        Message on WhatsApp
                      </a>
                    ) : null}
                  </span>
                </div>
              ) : null}

              <button
                className="button form-wide"
                type="submit"
                disabled={pending}
              >
                {pending ? "Sending…" : "Send my request"}
              </button>
            </form>
          </>
          )}
        </div>
      </section>
    </div>
  );
}
