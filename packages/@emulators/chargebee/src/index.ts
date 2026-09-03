import type { Hono } from "@emulators/core";
import type {
  AppEnv,
  RouteContext,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
  WebhookHeaderContext,
} from "@emulators/core";
import { materializeSubscription } from "./billing.js";
import type { ItemType, PeriodUnit, PricingModel } from "./entities.js";
import { chargebeeError, chargebeeId, DEFAULT_EPOCH, setNow } from "./helpers.js";
import { catalogRoutes } from "./routes/catalog.js";
import { customerRoutes } from "./routes/customers.js";
import { eventRoutes } from "./routes/events.js";
import { hostedPageRoutes } from "./routes/hosted-pages.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { paymentSourceRoutes } from "./routes/payment-sources.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { timeMachineRoutes } from "./routes/time-machine.js";
import { getChargebeeStore } from "./store.js";

export { getChargebeeStore, type ChargebeeStore } from "./store.js";
export * from "./entities.js";
export { addPeriod, DEFAULT_EPOCH } from "./helpers.js";

export interface ChargebeeSeedConfig {
  port?: number;
  /** Starting clock, as a unix timestamp or an ISO 8601 string. */
  now?: number | string;
  customers?: Array<{
    id?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    auto_collection?: "on" | "off";
    net_term_days?: number;
    currency_code?: string;
    /** Attach a valid card, so invoices for this customer settle rather than sit payable. */
    with_card?: boolean;
  }>;
  item_families?: Array<{ id: string; name?: string }>;
  items?: Array<{ id: string; name?: string; type?: ItemType; item_family?: string }>;
  item_prices?: Array<{
    id: string;
    item: string;
    name?: string;
    price: number;
    period?: number;
    period_unit?: PeriodUnit;
    currency_code?: string;
    pricing_model?: PricingModel;
    free_quantity?: number;
    trial_period?: number;
    trial_period_unit?: PeriodUnit;
  }>;
  subscriptions?: Array<{ customer: string; item_price: string; quantity?: number }>;
  webhooks?: Array<{ url: string; events: string[]; secret?: string }>;
}

/**
 * Chargebee authenticates webhook deliveries with HTTP basic credentials configured
 * on the receiving endpoint. It does not send an HMAC signature header, so none is
 * invented here: signing would let an application be tested against a header
 * production never sends.
 *
 * A configured secret of `user:pass` becomes those basic credentials; a bare value
 * is used as the username with an empty password.
 */
function chargebeeWebhookHeaders({ subscription }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (subscription.secret) {
    const separator = subscription.secret.indexOf(":");
    const credentials = separator === -1 ? `${subscription.secret}:` : subscription.secret;
    headers["Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  return headers;
}

function seedClock(store: Store, value: number | string | undefined): void {
  const cs = getChargebeeStore(store);
  if (value === undefined) {
    setNow(cs, DEFAULT_EPOCH);
    return;
  }
  const seconds = typeof value === "number" ? value : Math.floor(Date.parse(value) / 1000);
  setNow(cs, Number.isFinite(seconds) ? seconds : DEFAULT_EPOCH);
}

function insertCard(store: Store, customerId: string): void {
  const cs = getChargebeeStore(store);
  const customer = cs.customers.findOneBy("chargebee_id", customerId);
  if (!customer) return;

  const at = customer.created;
  const source = cs.paymentSources.insert({
    chargebee_id: chargebeeId("pm"),
    customer_id: customerId,
    status: "valid",
    reference_id: chargebeeId("ref"),
    card: {
      first_name: customer.first_name,
      last_name: customer.last_name,
      iin: "411111",
      last4: "1111",
      brand: "visa",
      expiry_month: 12,
      expiry_year: 2030,
      masked_number: "************1111",
    },
    created: at,
    updated: at,
  });

  cs.customers.update(customer.id, { card_status: "valid", primary_payment_source_id: source.chargebee_id });
}

/**
 * A minimal working world: one plan and one customer who can actually be billed.
 *
 * Without a card the very first invoice would sit at payment_due, which is a
 * confusing default for someone who just wants to see a subscription work.
 */
function seedDefaults(store: Store): void {
  const cs = getChargebeeStore(store);
  seedClock(store, undefined);
  const at = DEFAULT_EPOCH;

  cs.itemFamilies.insert({ chargebee_id: "emulate", name: "Emulate", created: at, updated: at });
  cs.items.insert({
    chargebee_id: "pro",
    name: "Pro",
    external_name: null,
    type: "plan",
    item_family_id: "emulate",
    metered: false,
    created: at,
    updated: at,
  });
  cs.itemPrices.insert({
    chargebee_id: "pro-monthly",
    name: "Pro Monthly",
    external_name: null,
    item_family_id: "emulate",
    item_id: "pro",
    item_type: "plan",
    pricing_model: "per_unit",
    price: 3000,
    period: 1,
    period_unit: "month",
    free_quantity: 0,
    currency_code: "USD",
    trial_period: null,
    trial_period_unit: null,
    created: at,
    updated: at,
  });

  cs.customers.insert({
    chargebee_id: "cbdemo_customer",
    first_name: "Test",
    last_name: "Customer",
    email: "test@example.com",
    company: null,
    phone: null,
    locale: null,
    auto_collection: "on",
    net_term_days: 0,
    preferred_currency_code: "USD",
    card_status: "no_card",
    primary_payment_source_id: null,
    billing_address: null,
    meta_data: {},
    cf_fields: {},
    created: at,
    updated: at,
  });
  insertCard(store, "cbdemo_customer");
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ChargebeeSeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  const cs = getChargebeeStore(store);
  seedClock(store, config.now);
  const at = getChargebeeStore(store).meta.all()[0]?.now ?? DEFAULT_EPOCH;

  for (const family of config.item_families ?? []) {
    if (cs.itemFamilies.findOneBy("chargebee_id", family.id)) continue;
    cs.itemFamilies.insert({ chargebee_id: family.id, name: family.name ?? family.id, created: at, updated: at });
  }

  for (const item of config.items ?? []) {
    if (cs.items.findOneBy("chargebee_id", item.id)) continue;
    const familyId = item.item_family ?? config.item_families?.[0]?.id ?? "emulate";
    if (!cs.itemFamilies.findOneBy("chargebee_id", familyId)) {
      cs.itemFamilies.insert({ chargebee_id: familyId, name: familyId, created: at, updated: at });
    }
    cs.items.insert({
      chargebee_id: item.id,
      name: item.name ?? item.id,
      external_name: null,
      type: item.type ?? "plan",
      item_family_id: familyId,
      metered: false,
      created: at,
      updated: at,
    });
  }

  for (const price of config.item_prices ?? []) {
    if (cs.itemPrices.findOneBy("chargebee_id", price.id)) continue;
    const item = cs.items.findOneBy("chargebee_id", price.item);
    if (!item) continue;
    cs.itemPrices.insert({
      chargebee_id: price.id,
      name: price.name ?? price.id,
      external_name: null,
      item_family_id: item.item_family_id,
      item_id: item.chargebee_id,
      item_type: item.type,
      pricing_model: price.pricing_model ?? "per_unit",
      price: price.price,
      period: price.period ?? 1,
      period_unit: price.period_unit ?? "month",
      free_quantity: price.free_quantity ?? 0,
      currency_code: price.currency_code ?? "USD",
      trial_period: price.trial_period ?? null,
      trial_period_unit: price.trial_period_unit ?? null,
      created: at,
      updated: at,
    });
  }

  for (const customer of config.customers ?? []) {
    const id = customer.id ?? chargebeeId("cus");
    if (cs.customers.findOneBy("chargebee_id", id)) continue;
    if (customer.email && cs.customers.findOneBy("email", customer.email)) continue;

    cs.customers.insert({
      chargebee_id: id,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      email: customer.email ?? null,
      company: customer.company ?? null,
      phone: null,
      locale: null,
      auto_collection: customer.auto_collection ?? "on",
      net_term_days: customer.net_term_days ?? 0,
      preferred_currency_code: customer.currency_code ?? "USD",
      card_status: "no_card",
      primary_payment_source_id: null,
      billing_address: null,
      meta_data: {},
      cf_fields: {},
      created: at,
      updated: at,
    });

    if (customer.with_card !== false) insertCard(store, id);
  }

  for (const subscription of config.subscriptions ?? []) {
    const customer =
      cs.customers.findOneBy("chargebee_id", subscription.customer) ??
      cs.customers.findOneBy("email", subscription.customer);
    if (!customer) continue;
    if (!cs.itemPrices.findOneBy("chargebee_id", subscription.item_price)) continue;

    materializeSubscription(cs, {
      customerId: customer.chargebee_id,
      items: [{ itemPriceId: subscription.item_price, quantity: subscription.quantity ?? 1 }],
    });
  }

  if (config.webhooks && webhooks) {
    webhooks.setHeaderFactory(chargebeeWebhookHeaders);
    for (const hook of config.webhooks) {
      webhooks.register({
        url: hook.url,
        events: hook.events,
        active: true,
        secret: hook.secret,
        owner: "chargebee",
      });
    }
  }
}

export const chargebeePlugin: ServicePlugin = {
  name: "chargebee",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    webhooks.setHeaderFactory(chargebeeWebhookHeaders);

    // Chargebee authenticates with HTTP basic, the API key as the username and an
    // empty password. Any key is accepted, but a missing one is still rejected so a
    // misconfigured client fails here the way it would in production instead of
    // quietly succeeding.
    // Scoped by hand rather than by route pattern: the router only treats a bare "*"
    // as a wildcard, so a prefixed pattern would silently never match and every
    // request would sail through unauthenticated.
    app.use("*", async (c, next) => {
      if (!new URL(c.req.url).pathname.startsWith("/api/v2/")) {
        await next();
        return;
      }
      const header = c.req.header("Authorization") ?? "";
      if (!header.toLowerCase().startsWith("basic ")) {
        return chargebeeError(c, 401, "api_authentication_failed", "Sorry, authentication failed. Invalid API key");
      }
      await next();
    });

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    customerRoutes(ctx);
    catalogRoutes(ctx);
    subscriptionRoutes(ctx);
    invoiceRoutes(ctx);
    paymentSourceRoutes(ctx);
    hostedPageRoutes(ctx);
    eventRoutes(ctx);
    timeMachineRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default chargebeePlugin;
