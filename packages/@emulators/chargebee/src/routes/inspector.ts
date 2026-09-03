import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { now } from "../helpers.js";
import { getChargebeeStore } from "../store.js";

const SERVICE_LABEL = "Chargebee";

const TABS: InspectorTab[] = [
  { id: "customers", label: "Customers", href: "/?tab=customers" },
  { id: "subscriptions", label: "Subscriptions", href: "/?tab=subscriptions" },
  { id: "invoices", label: "Invoices", href: "/?tab=invoices" },
  { id: "catalog", label: "Catalog", href: "/?tab=catalog" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "coverage", label: "Coverage", href: "/?tab=coverage" },
];

type TabId = (typeof TABS)[number]["id"];

/** Resolve a query value to a known tab without asserting its type. */
function asTabId(value: string | undefined): TabId {
  return TABS.find((tab) => tab.id === value)?.id ?? "customers";
}

/**
 * What the emulator claims about itself.
 *
 * Billing is mostly arithmetic, and the arithmetic Chargebee applies for proration,
 * tax and dunning is not published. Rather than guess and let a scenario pass over
 * figures production would compute differently, those operations are refused, and
 * this table is where a reader finds out which is which before trusting a result.
 */
const COVERAGE: Array<{ area: string; level: "Exact" | "Approximated" | "Refused"; note: string }> = [
  {
    area: "Customers, catalog, payment sources",
    level: "Exact",
    note: "Field handling, partial updates, id collisions, filters and opaque-offset pagination follow the documented API.",
  },
  {
    area: "Subscription lifecycle",
    level: "Exact",
    note: "Status transitions and calendar-aware term arithmetic, including short-month clamping: a term anchored on 31 January advances to 28 February.",
  },
  {
    area: "Unprorated item changes",
    level: "Exact",
    note: "Fully determined by the request. The prorated path is refused instead.",
  },
  {
    area: "Invoice generation",
    level: "Approximated",
    note: "Line items, totals and term windows are exact for per_unit and flat_fee pricing. Tax is always zero and payment settles instantly when a valid card exists, so no gateway latency or decline is modelled.",
  },
  {
    area: "Time machine",
    level: "Approximated",
    note: "Same response shape, but instantaneous and always successful rather than queued and rate limited.",
  },
  {
    area: "Portal sessions, hosted pages",
    level: "Approximated",
    note: "Correctly shaped objects whose URLs resolve to a placeholder. No Chargebee-hosted UI is reproduced.",
  },
  {
    area: "Proration, tax, dunning",
    level: "Refused",
    note: "Undocumented arithmetic. Returns 501 with api_error_code not_emulated, a code the real API never sends.",
  },
  {
    area: "Estimates, coupons, credit notes, refunds, metered usage, tiered pricing",
    level: "Refused",
    note: "Pricing-engine behavior that cannot be reproduced faithfully. Any scenario that depends on it must run against a real Chargebee site.",
  },
];

function table(headers: readonly string[], rows: readonly string[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<table class="inspector-table">
  <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
</table>`;
}

function section(title: string, inner: string): string {
  return `<section class="inspector-section"><h2>${escapeHtml(title)}</h2>${inner}</section>`;
}

function stamp(seconds: number | null): string {
  if (seconds === null) return "&mdash;";
  return escapeHtml(new Date(seconds * 1000).toISOString().replace(".000Z", "Z"));
}

function money(minor: number, currency: string): string {
  return escapeHtml(`${(minor / 100).toFixed(2)} ${currency}`);
}

export function inspectorRoutes({ app, store }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.get("/", (c) => {
    const active = asTabId(c.req.query("tab"));

    let body: string;

    if (active === "subscriptions") {
      body = section(
        "Subscriptions",
        table(
          ["ID", "Customer", "Status", "Term start", "Term end", "Next billing", "MRR"],
          cs.subscriptions
            .all()
            .map((subscription) => [
              escapeHtml(subscription.chargebee_id),
              escapeHtml(subscription.customer_id),
              `<span class="badge">${escapeHtml(subscription.status)}</span>`,
              stamp(subscription.current_term_start),
              stamp(subscription.current_term_end),
              stamp(subscription.next_billing_at),
              money(subscription.mrr, subscription.currency_code),
            ]),
          "No subscriptions yet.",
        ),
      );
    } else if (active === "invoices") {
      body = section(
        "Invoices",
        table(
          ["ID", "Customer", "Subscription", "Status", "Date", "Total", "Due"],
          cs.invoices
            .all()
            .sort((left, right) => left.date - right.date || left.id - right.id)
            .map((invoice) => [
              escapeHtml(invoice.chargebee_id),
              escapeHtml(invoice.customer_id),
              escapeHtml(invoice.subscription_id ?? "—"),
              `<span class="badge">${escapeHtml(invoice.status)}</span>`,
              stamp(invoice.date),
              money(invoice.total, invoice.currency_code),
              money(invoice.amount_due, invoice.currency_code),
            ]),
          "No invoices yet. Create a subscription or move the clock forward.",
        ),
      );
    } else if (active === "catalog") {
      body = [
        section(
          "Item families",
          table(
            ["ID", "Name"],
            cs.itemFamilies.all().map((family) => [escapeHtml(family.chargebee_id), escapeHtml(family.name)]),
            "No item families yet.",
          ),
        ),
        section(
          "Items",
          table(
            ["ID", "Name", "Type", "Family"],
            cs.items
              .all()
              .map((item) => [
                escapeHtml(item.chargebee_id),
                escapeHtml(item.name),
                `<span class="badge">${escapeHtml(item.type)}</span>`,
                escapeHtml(item.item_family_id),
              ]),
            "No items yet.",
          ),
        ),
        section(
          "Item prices",
          table(
            ["ID", "Item", "Price", "Period", "Model", "Trial"],
            cs.itemPrices
              .all()
              .map((price) => [
                escapeHtml(price.chargebee_id),
                escapeHtml(price.item_id),
                money(price.price, price.currency_code),
                escapeHtml(`${price.period} ${price.period_unit}`),
                escapeHtml(price.pricing_model),
                price.trial_period === null
                  ? "&mdash;"
                  : escapeHtml(`${price.trial_period} ${price.trial_period_unit ?? "day"}`),
              ]),
            "No item prices yet.",
          ),
        ),
      ].join("");
    } else if (active === "events") {
      body = section(
        "Events",
        table(
          ["ID", "Type", "Occurred at"],
          cs.events
            .all()
            .sort((left, right) => right.occurred_at - left.occurred_at || right.id - left.id)
            .map((event) => [
              escapeHtml(event.chargebee_id),
              `<span class="badge">${escapeHtml(event.event_type)}</span>`,
              stamp(event.occurred_at),
            ]),
          "No events yet.",
        ),
      );
    } else if (active === "coverage") {
      body = section(
        "What this emulator reproduces",
        table(
          ["Area", "Fidelity", "Notes"],
          COVERAGE.map((entry) => [
            escapeHtml(entry.area),
            `<span class="badge">${escapeHtml(entry.level)}</span>`,
            escapeHtml(entry.note),
          ]),
          "",
        ),
      );
    } else {
      body = [
        section(
          "Clock",
          `<p class="empty">Emulator time is <strong>${stamp(now(cs))}</strong>. Move it with <code>POST /api/v2/time_machines/default/travel_forward</code>.</p>`,
        ),
        section(
          "Customers",
          table(
            ["ID", "Email", "Company", "Card", "Auto collection"],
            cs.customers
              .all()
              .map((customer) => [
                escapeHtml(customer.chargebee_id),
                escapeHtml(customer.email ?? "—"),
                escapeHtml(customer.company ?? "—"),
                `<span class="badge">${escapeHtml(customer.card_status)}</span>`,
                escapeHtml(customer.auto_collection),
              ]),
            "No customers yet.",
          ),
        ),
      ].join("");
    }

    return c.html(renderInspectorPage("Chargebee inspector", TABS, active, body, SERVICE_LABEL));
  });
}
