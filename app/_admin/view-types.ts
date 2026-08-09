/**
 * Shapes the admin screens read. Shared contract between the Today queue and
 * the orders screens, so two agents can build against one definition.
 *
 * WHY THE STOREFRONT'S QUERIES CANNOT BE REUSED — research/04-admin-integration.md
 *   readOrderForCart()  is authorised by the CART COOKIE. An admin has no cart.
 *   readCatalogue()     falls back to a compiled seed when D1 is empty, which is
 *                       right for a shop window and wrong for a management
 *                       screen: the owner must see what is in the database, not
 *                       a plausible substitute.
 * Both need admin-shaped parallels. That is a feature of the split, not
 * duplication to be tidied away later.
 *
 * WHY EVERY ORDER READ CARRIES `intact`
 * D1 has no interactive transactions, so `orders.lineItemCount` exists as a
 * torn-write detector and `assertOrderIntact()` is exported for exactly this.
 * A torn order must be REPORTED, never rendered as though its figures were
 * complete — an invoice missing a line is worse than an error message.
 */

/** What the owner actually opens the panel to deal with. */
export type QueueKind = "order" | "appointment" | "complaint";

/**
 * One thing needing a human. The queue is sorted by obligation, not recency:
 * a complaint carries a statutory clock and an order does not.
 */
export type QueueItem = {
  kind: QueueKind;
  id: string;
  /** Order number, ticket number, or the enquiry's id. What the owner quotes. */
  reference: string;
  /** The person. The owner's unit of work is a customer, not a record. */
  name: string | null;
  phone: string | null;
  receivedAt: string;
  /**
   * Set ONLY for a complaint. Rule 4(5) starts on a complaint, never on a
   * purchase — an order that carried a deadline was the defect fixed in
   * phase 0, and reintroducing one here would undo it.
   */
  dueAt: string | null;
  overdue: boolean;
  summary: string;
};

/** The four real reasons this shop is not open yet, and how to resolve each. */
export type SetupGap = {
  id: "contact_details" | "catalogue" | "gold_rate" | "payment_capture";
  title: string;
  detail: string;
  /** Where the owner goes to fix it, or null when it is not fixable in here. */
  href: string | null;
  resolved: boolean;
};

export type AdminOrderRow = {
  id: string;
  orderNumber: string;
  placedAt: string;
  customerName: string | null;
  customerPhone: string | null;
  status: string;
  fulfilmentStatus: string;
  lineCount: number;
  /** Null when the order is torn — never a partial sum presented as a total. */
  totalPaise: number | null;
  intact: boolean;
  cancelledAt: string | null;
};

export type AdminOrderLine = {
  title: string;
  sku: string;
  quantity: number;
  /** The statutory snapshot, itemised. BIS Reg. 5(11). */
  breakup: readonly { label: string; amountPaise: number }[];
  lineTotalPaise: number;
  /** Null stays null and is explained on screen, never blanked or invented. */
  huid: string | null;
  purityLabel: string | null;
  netMetalWeightMg: number | null;
};

export type AdminOrderDetail = AdminOrderRow & {
  lines: readonly AdminOrderLine[];
  /** Contact and address as snapshotted onto the order, not re-read live. */
  contact: { name: string | null; phone: string | null; email: string | null };
  /** Which transitions this order may take, resolved server-side. */
  allowedActions: readonly ("cancel" | "mark_ready" | "mark_collected")[];
  /**
   * Why a payment-bearing action is unavailable, when it is. With capture off
   * the status control must not be able to express a payment state nobody
   * authorised — the top-rated risk in research/04.
   */
  paymentActionsBlockedReason: string | null;
};
