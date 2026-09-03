import { beforeEach, describe, expect, it, vi } from "vitest";
import { addPeriod, DEFAULT_EPOCH } from "../index.js";
import { AUTH, catalogSeed, createChargebeeTestApp, form, get, post } from "./helpers.js";

const FEB_1 = Date.parse("2026-02-01T00:00:00Z") / 1000;
const YEAR = 365 * 86400;

function subscribe(quantity?: number): Record<string, string | number | undefined> {
  return {
    "subscription_items[item_price_id][0]": "pro-monthly",
    ...(quantity === undefined ? {} : { "subscription_items[quantity][0]": quantity }),
  };
}

describe("period arithmetic", () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

  it("advances whole months on the same day", () => {
    expect(iso(addPeriod(Date.parse("2026-03-15T00:00:00Z") / 1000, 1, "month"))).toBe("2026-04-15T00:00:00.000Z");
  });

  it("clamps to the end of a shorter month", () => {
    // The classic billing bug: a term anchored on the 31st has no 31st to land on.
    expect(iso(addPeriod(Date.parse("2026-01-31T00:00:00Z") / 1000, 1, "month"))).toBe("2026-02-28T00:00:00.000Z");
  });

  it("returns to the anchor day after a clamped month", () => {
    const january = Date.parse("2026-01-31T00:00:00Z") / 1000;
    expect(iso(addPeriod(january, 2, "month"))).toBe("2026-03-31T00:00:00.000Z");
  });

  it("accounts for leap years", () => {
    expect(iso(addPeriod(Date.parse("2028-01-31T00:00:00Z") / 1000, 1, "month"))).toBe("2028-02-29T00:00:00.000Z");
    expect(iso(addPeriod(Date.parse("2028-02-29T00:00:00Z") / 1000, 1, "year"))).toBe("2029-02-28T00:00:00.000Z");
  });

  it("preserves the time of day", () => {
    expect(iso(addPeriod(Date.parse("2026-01-15T13:45:30Z") / 1000, 2, "month"))).toBe("2026-03-15T13:45:30.000Z");
  });
});

describe("authentication", () => {
  it("rejects a request with no credentials", async () => {
    const { app } = createChargebeeTestApp();
    const response = await app.request("/api/v2/customers");
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.api_error_code).toBe("api_authentication_failed");
    expect(body.type).toBe("invalid_request");
  });

  it("accepts any api key", async () => {
    const { app } = createChargebeeTestApp();
    const response = await app.request("/api/v2/customers", { headers: { Authorization: AUTH } });
    expect(response.status).toBe(200);
  });
});

describe("customers", () => {
  let app: ReturnType<typeof createChargebeeTestApp>["app"];

  beforeEach(() => {
    app = createChargebeeTestApp(catalogSeed()).app;
  });

  it("creates with the documented shape", async () => {
    const created = await post(app, "/api/v2/customers", {
      id: "cus_new",
      email: "new@acme.example",
      company: "Acme",
      auto_collection: "off",
    });
    expect(created.status).toBe(200);
    expect(created.body.customer).toMatchObject({
      id: "cus_new",
      object: "customer",
      email: "new@acme.example",
      company: "Acme",
      auto_collection: "off",
      card_status: "no_card",
      deleted: false,
    });
    expect(created.body.customer.created_at).toBe(DEFAULT_EPOCH);
  });

  it("leaves untouched fields alone on update", async () => {
    const updated = await post(app, "/api/v2/customers/cus_acme", { first_name: "Ada" });
    expect(updated.body.customer).toMatchObject({
      first_name: "Ada",
      company: "Acme",
      email: "billing@acme.example",
    });
  });

  it("rejects a duplicate id", async () => {
    const again = await post(app, "/api/v2/customers", { id: "cus_acme" });
    expect(again.status).toBe(409);
    expect(again.body.api_error_code).toBe("duplicate_entry");
  });

  it("returns the documented not-found shape", async () => {
    const missing = await get(app, "/api/v2/customers/nope");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      api_error_code: "resource_not_found",
      type: "invalid_request",
      http_status_code: 404,
    });
  });

  it("paginates with an opaque offset", async () => {
    for (let index = 0; index < 11; index += 1) {
      await post(app, "/api/v2/customers", { id: `cus_${index}` });
    }
    const first = await get(app, "/api/v2/customers?limit=5");
    expect(first.body.list).toHaveLength(5);
    expect(first.body.next_offset).toBe("5");

    const second = await get(app, `/api/v2/customers?limit=5&offset=${first.body.next_offset}`);
    expect(second.body.list).toHaveLength(5);
    expect(second.body.list[0].customer.id).not.toBe(first.body.list[0].customer.id);
  });

  it("filters with is and in operators", async () => {
    const byEmail = await get(app, "/api/v2/customers?email[is]=billing@acme.example");
    expect(byEmail.body.list).toHaveLength(1);

    const byId = await get(app, `/api/v2/customers?id[in]=${encodeURIComponent('["cus_acme","missing"]')}`);
    expect(byId.body.list).toHaveLength(1);
  });
});

describe("subscription creation", () => {
  it("activates immediately and issues a paid first invoice", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe(2));

    expect(created.status).toBe(200);
    expect(created.body.subscription).toMatchObject({
      object: "subscription",
      status: "active",
      customer_id: "cus_acme",
      billing_period: 1,
      billing_period_unit: "month",
      currency_code: "USD",
      mrr: 6000,
    });
    // 2026-02-01, not the epoch plus thirty days.
    expect(created.body.subscription.current_term_start).toBe(DEFAULT_EPOCH);
    expect(created.body.subscription.current_term_end).toBe(FEB_1);
    expect(created.body.subscription.next_billing_at).toBe(FEB_1);

    expect(created.body.subscription.subscription_items).toHaveLength(1);
    expect(created.body.subscription.subscription_items[0]).toMatchObject({
      item_price_id: "pro-monthly",
      quantity: 2,
      unit_price: 3000,
      amount: 6000,
      object: "subscription_item",
    });

    expect(created.body.invoice).toMatchObject({
      object: "invoice",
      status: "paid",
      total: 6000,
      amount_paid: 6000,
      amount_due: 0,
      first_invoice: true,
    });
    expect(created.body.invoice.line_items[0]).toMatchObject({
      quantity: 2,
      unit_amount: 3000,
      amount: 6000,
      date_from: DEFAULT_EPOCH,
      date_to: FEB_1,
      entity_id: "pro-monthly",
    });
    expect(created.body.customer.id).toBe("cus_acme");
  });

  it("leaves the invoice payable when the customer has no card", async () => {
    const seed = catalogSeed();
    seed.customers = [{ id: "cus_nocard", email: "nocard@acme.example", with_card: false }];
    const { app } = createChargebeeTestApp(seed);

    const created = await post(app, "/api/v2/customers/cus_nocard/subscription_for_items", subscribe());
    expect(created.body.invoice).toMatchObject({ status: "payment_due", amount_paid: 0, amount_due: 3000 });
    const fetched = await get(app, `/api/v2/subscriptions/${created.body.subscription.id}`);
    expect(fetched.body.subscription.due_invoices_count).toBe(1);
  });

  it("starts in trial when the plan carries one", async () => {
    const { app } = createChargebeeTestApp(catalogSeed({ trialDays: 14 }));
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());

    expect(created.body.subscription.status).toBe("in_trial");
    expect(created.body.subscription.trial_end).toBe(DEFAULT_EPOCH + 14 * 86400);
    expect(created.body.invoice).toBeUndefined();
  });

  it("refuses an unknown item price", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", {
      "subscription_items[item_price_id][0]": "ghost-plan",
    });
    expect(created.status).toBe(404);
    expect(created.body.api_error_code).toBe("resource_not_found");
    expect(created.body.message).toContain("ghost-plan");
  });

  it("requires exactly one plan", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", {});
    expect(created.status).toBe(400);
    expect(created.body.param).toBe("subscription_items");
  });
});

describe("time travel", () => {
  it("produces a year of monthly renewals in order", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());

    const travelled = await post(app, "/api/v2/time_machines/default/travel_forward", {
      destination_time: DEFAULT_EPOCH + YEAR,
    });
    expect(travelled.status).toBe(200);
    expect(travelled.body.time_machine.time_travel_status).toBe("succeeded");

    const invoices = await get(app, "/api/v2/invoices?limit=100");
    // One at activation plus twelve renewals through 2027-01-01.
    expect(invoices.body.list).toHaveLength(13);
    const dates = invoices.body.list.map((entry: any) =>
      new Date(entry.invoice.date * 1000).toISOString().slice(0, 10),
    );
    expect(dates[0]).toBe("2026-01-01");
    expect(dates.at(-1)).toBe("2027-01-01");

    const events = await get(app, "/api/v2/events?limit=100");
    const renewals = events.body.list.filter((entry: any) => entry.event.event_type === "subscription_renewed");
    expect(renewals).toHaveLength(12);
  });

  it("activates a trial subscription when the trial elapses", async () => {
    const { app } = createChargebeeTestApp(catalogSeed({ trialDays: 14 }));
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());

    await post(app, "/api/v2/time_machines/default/travel_forward", {
      destination_time: DEFAULT_EPOCH + 15 * 86400,
    });

    const after = await get(app, `/api/v2/subscriptions/${created.body.subscription.id}`);
    expect(after.body.subscription.status).toBe("active");
    expect(after.body.subscription.activated_at).toBe(DEFAULT_EPOCH + 14 * 86400);

    const invoices = await get(app, "/api/v2/invoices");
    expect(invoices.body.list).toHaveLength(1);
    expect(invoices.body.list[0].invoice.first_invoice).toBe(true);
  });

  it("refuses to travel backwards", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await post(app, "/api/v2/time_machines/default/travel_forward", {
      destination_time: DEFAULT_EPOCH - 10,
    });
    expect(response.status).toBe(409);
    expect(response.body.api_error_code).toBe("invalid_state_for_request");
  });

  it("reports the clock without moving it", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const machine = await get(app, "/api/v2/time_machines/default");
    expect(machine.body.time_machine.destination_time).toBe(DEFAULT_EPOCH);
  });
});

describe("cancellation", () => {
  it("moves through non_renewing and ends at the term boundary", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());
    const id = created.body.subscription.id;

    const cancelled = await post(app, `/api/v2/subscriptions/${id}/cancel_for_items`, {
      end_of_term: "true",
      cancel_reason_code: "not_paid",
    });
    expect(cancelled.body.subscription.status).toBe("non_renewing");

    await post(app, "/api/v2/time_machines/default/travel_forward", {
      destination_time: DEFAULT_EPOCH + 40 * 86400,
    });

    const after = await get(app, `/api/v2/subscriptions/${id}`);
    expect(after.body.subscription.status).toBe("cancelled");

    // A cancelled subscription must stop billing.
    const invoices = await get(app, "/api/v2/invoices");
    expect(invoices.body.list).toHaveLength(1);
  });

  it("cancels immediately and refuses a second cancellation", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());
    const id = created.body.subscription.id;

    const cancelled = await post(app, `/api/v2/subscriptions/${id}/cancel_for_items`, {});
    expect(cancelled.body.subscription).toMatchObject({ status: "cancelled", cancelled_at: DEFAULT_EPOCH });

    const again = await post(app, `/api/v2/subscriptions/${id}/cancel_for_items`, {});
    expect(again.status).toBe(409);
  });

  it("reactivates onto a fresh term", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());
    const id = created.body.subscription.id;

    await post(app, `/api/v2/subscriptions/${id}/cancel_for_items`, {});
    await post(app, "/api/v2/time_machines/default/travel_forward", {
      destination_time: DEFAULT_EPOCH + 10 * 86400,
    });

    const reactivated = await post(app, `/api/v2/subscriptions/${id}/reactivate`, {});
    expect(reactivated.body.subscription.status).toBe("active");
    expect(reactivated.body.subscription.current_term_start).toBe(DEFAULT_EPOCH + 10 * 86400);
    expect(reactivated.body.invoice).toBeDefined();
  });
});

describe("declared boundaries", () => {
  it("refuses estimates rather than inventing arithmetic", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await post(app, "/api/v2/estimates/create_subscription_for_items", {});
    expect(response.status).toBe(501);
    expect(response.body.api_error_code).toBe("not_emulated");
  });

  it("allows an unprorated item change but refuses a prorated one", async () => {
    const seed = catalogSeed();
    seed.item_prices?.push({
      id: "pro-yearly",
      item: "pro",
      name: "Pro Yearly",
      price: 30000,
      period: 1,
      period_unit: "year",
    });
    const { app } = createChargebeeTestApp(seed);

    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());
    const id = created.body.subscription.id;

    const prorated = await post(app, `/api/v2/subscriptions/${id}/update_for_items`, {
      "subscription_items[item_price_id][0]": "pro-yearly",
      prorate: "true",
    });
    expect(prorated.status).toBe(501);
    expect(prorated.body.api_error_code).toBe("not_emulated");

    const plain = await post(app, `/api/v2/subscriptions/${id}/update_for_items`, {
      "subscription_items[item_price_id][0]": "pro-yearly",
      prorate: "false",
    });
    expect(plain.status).toBe(200);
    expect(plain.body.subscription.billing_period_unit).toBe("year");
    expect(plain.body.subscription.mrr).toBe(2500);
  });

  it("refuses coupons instead of silently dropping them", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", {
      ...subscribe(),
      "coupon_ids[0]": "WELCOME",
    });
    expect(response.status).toBe(501);
  });

  it("refuses a pricing model it cannot compute", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await post(app, "/api/v2/item_prices", {
      id: "tiered-plan",
      item: "pro",
      item_id: "pro",
      pricing_model: "tiered",
    });
    expect(response.status).toBe(501);
  });

  it("refuses dunning, refunds and metered usage", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    for (const path of ["/api/v2/invoices/1/collect_payment", "/api/v2/invoices/1/refund", "/api/v2/usages"]) {
      const response = await post(app, path, {});
      expect(response.status, path).toBe(501);
    }
  });
});

describe("webhooks", () => {
  it("delivers events with basic credentials, as Chargebee does", async () => {
    const calls: Array<{ url: string; body: any; auth: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        calls.push({
          url: String(url),
          body: JSON.parse(init.body as string),
          auth: (init.headers as Record<string, string>)["Authorization"],
        });
        return new Response("{}", { status: 200 });
      }),
    );

    const seed = catalogSeed();
    seed.webhooks = [{ url: "http://localhost:9999/hooks/chargebee", events: ["*"], secret: "hookuser:hookpass" }];
    const { app } = createChargebeeTestApp(seed);

    await post(app, "/api/v2/customers/cus_acme/subscription_for_items", subscribe());

    const types = calls.map((call) => call.body.event_type);
    expect(types).toContain("subscription_created");
    expect(types).toContain("invoice_generated");
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from("hookuser:hookpass").toString("base64")}`);

    vi.unstubAllGlobals();
  });
});

describe("inspector", () => {
  it("serves a coverage tab that states what is refused", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await app.request("/?tab=coverage");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("Proration, tax, dunning");
    expect(html).toContain("Refused");
    expect(html).toContain("not_emulated");
  });

  it("lists seeded customers", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const html = await (await app.request("/")).text();
    expect(html).toContain("cus_acme");
  });
});

describe("seeding", () => {
  it("builds a starting world without firing webhooks", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const seed = catalogSeed();
    seed.subscriptions = [{ customer: "cus_acme", item_price: "pro-monthly", quantity: 3 }];
    seed.webhooks = [{ url: "http://localhost:9999/hooks", events: ["*"] }];
    const { app } = createChargebeeTestApp(seed);

    const subscriptions = await get(app, "/api/v2/subscriptions");
    expect(subscriptions.body.list).toHaveLength(1);
    expect(subscriptions.body.list[0].subscription.subscription_items[0].quantity).toBe(3);

    const invoices = await get(app, "/api/v2/invoices");
    expect(invoices.body.list).toHaveLength(1);

    // Seeded state is a precondition, not something that just happened.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("honours an explicit starting clock", async () => {
    const seed = catalogSeed();
    seed.now = "2030-06-15T00:00:00Z";
    const { app } = createChargebeeTestApp(seed);

    const machine = await get(app, "/api/v2/time_machines/default");
    expect(machine.body.time_machine.destination_time).toBe(Date.parse("2030-06-15T00:00:00Z") / 1000);
  });

  it("provides a working default world", async () => {
    const { app } = createChargebeeTestApp();
    const price = await get(app, "/api/v2/item_prices/pro-monthly");
    expect(price.body.item_price.price).toBe(3000);

    const created = await post(app, "/api/v2/customers/cbdemo_customer/subscription_for_items", subscribe());
    expect(created.body.invoice.status).toBe("paid");
  });
});

describe("form encoding", () => {
  it("keeps indexed item attributes aligned", async () => {
    const seed = catalogSeed();
    seed.items?.push({ id: "seats", name: "Seats", type: "addon", item_family: "acme" });
    seed.item_prices?.push({
      id: "seats-monthly",
      item: "seats",
      name: "Seats Monthly",
      price: 500,
      period: 1,
      period_unit: "month",
    });
    const { app } = createChargebeeTestApp(seed);

    const created = await post(app, "/api/v2/customers/cus_acme/subscription_for_items", {
      "subscription_items[item_price_id][0]": "pro-monthly",
      "subscription_items[quantity][0]": 1,
      "subscription_items[item_price_id][1]": "seats-monthly",
      "subscription_items[quantity][1]": 4,
    });

    const items = created.body.subscription.subscription_items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ item_price_id: "pro-monthly", quantity: 1, amount: 3000 });
    expect(items[1]).toMatchObject({ item_price_id: "seats-monthly", quantity: 4, amount: 2000 });
    expect(created.body.invoice.total).toBe(5000);
  });

  it("accepts a JSON body as well as form encoding", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await app.request("/api/v2/customers", {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cus_json", email: "json@acme.example" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.customer.email).toBe("json@acme.example");
  });

  it("decodes plus as a space", async () => {
    const { app } = createChargebeeTestApp(catalogSeed());
    const response = await app.request("/api/v2/customers", {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ id: "cus_space", first_name: "Ada Lovelace" }),
    });
    const body = (await response.json()) as any;
    expect(body.customer.first_name).toBe("Ada Lovelace");
  });
});
