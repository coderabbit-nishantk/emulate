import type { Context, RouteContext } from "@emulators/core";
import type { ChargebeeBillingAddress, ChargebeeCustomer } from "../entities.js";
import { formatCustomer } from "../formatters.js";
import {
  chargebeeError,
  chargebeeId,
  chargebeeList,
  fieldOf,
  matchesFilters,
  notFound,
  now,
  parseChargebeeBody,
  readFilters,
  readGroup,
  readNumber,
  readString,
} from "../helpers.js";
import { getChargebeeStore } from "../store.js";

function billingAddressFrom(body: Record<string, unknown>): ChargebeeBillingAddress | undefined {
  const group = readGroup(body, "billing_address");
  if (Object.keys(group).length === 0) return undefined;
  return {
    first_name: readString(group, "first_name"),
    last_name: readString(group, "last_name"),
    line1: readString(group, "line1"),
    line2: readString(group, "line2"),
    city: readString(group, "city"),
    state: readString(group, "state"),
    state_code: readString(group, "state_code"),
    country: readString(group, "country"),
    zip: readString(group, "zip"),
  };
}

/**
 * Build a partial update from a request body.
 *
 * Chargebee leaves absent fields untouched rather than clearing them, so only keys
 * actually present in the request appear in the patch.
 */
function customerPatch(body: Record<string, unknown>, at: number): Partial<ChargebeeCustomer> {
  const patch: Partial<ChargebeeCustomer> = { updated: at };

  const strings: Array<[keyof ChargebeeCustomer, string | undefined]> = [
    ["first_name", readString(body, "first_name")],
    ["last_name", readString(body, "last_name")],
    ["email", readString(body, "email")],
    ["company", readString(body, "company")],
    ["phone", readString(body, "phone")],
    ["locale", readString(body, "locale")],
  ];
  for (const [field, value] of strings) {
    if (value !== undefined) Object.assign(patch, { [field]: value });
  }

  const autoCollection = readString(body, "auto_collection");
  if (autoCollection === "on" || autoCollection === "off") patch.auto_collection = autoCollection;

  const netTermDays = readNumber(body, "net_term_days");
  if (netTermDays !== undefined) patch.net_term_days = netTermDays;

  const currency = readString(body, "preferred_currency_code");
  if (currency !== undefined) patch.preferred_currency_code = currency;

  const address = billingAddressFrom(body);
  if (address !== undefined) patch.billing_address = address;

  const metaData = readString(body, "meta_data");
  if (metaData !== undefined) {
    try {
      patch.meta_data = JSON.parse(metaData) as Record<string, unknown>;
    } catch {
      throw new Error("meta_data must be valid JSON");
    }
  }

  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("cf_") && typeof value === "string") custom[key] = value;
  }
  if (Object.keys(custom).length > 0) patch.cf_fields = custom;

  return patch;
}

export function customerRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.post("/api/v2/customers", async (c) => {
    const body = await parseChargebeeBody(c);
    const requestedId = readString(body, "id");

    if (requestedId && cs.customers.findOneBy("chargebee_id", requestedId)) {
      return chargebeeError(c, 409, "duplicate_entry", `Customer with id [${requestedId}] already exists`);
    }

    const at = now(cs);
    let patch: Partial<ChargebeeCustomer>;
    try {
      patch = customerPatch(body, at);
    } catch {
      return chargebeeError(
        c,
        400,
        "param_wrong_value",
        "meta_data must be valid JSON",
        "invalid_request",
        "meta_data",
      );
    }

    const customer = cs.customers.insert({
      chargebee_id: requestedId ?? chargebeeId("cus"),
      first_name: null,
      last_name: null,
      email: null,
      company: null,
      phone: null,
      locale: null,
      auto_collection: "on",
      net_term_days: 0,
      preferred_currency_code: readString(body, "preferred_currency_code") ?? "USD",
      card_status: "no_card",
      primary_payment_source_id: null,
      billing_address: null,
      meta_data: {},
      cf_fields: {},
      created: at,
      updated: at,
      ...patch,
    });

    await webhooks.dispatch(
      "customer_created",
      undefined,
      { event_type: "customer_created", content: { customer: formatCustomer(customer) } },
      "chargebee",
    );

    return c.json({ customer: formatCustomer(customer) });
  });

  app.get("/api/v2/customers/:id", (c) => {
    const customer = cs.customers.findOneBy("chargebee_id", c.req.param("id"));
    if (!customer) return notFound(c);
    return c.json({ customer: formatCustomer(customer) });
  });

  const update = async (c: Context) => {
    const customer = cs.customers.findOneBy("chargebee_id", c.req.param("id"));
    if (!customer) return notFound(c);

    const body = await parseChargebeeBody(c);
    let patch: Partial<ChargebeeCustomer>;
    try {
      patch = customerPatch(body, now(cs));
    } catch {
      return chargebeeError(
        c,
        400,
        "param_wrong_value",
        "meta_data must be valid JSON",
        "invalid_request",
        "meta_data",
      );
    }

    const updated = cs.customers.update(customer.id, patch);
    if (!updated) return notFound(c);

    await webhooks.dispatch(
      "customer_changed",
      undefined,
      { event_type: "customer_changed", content: { customer: formatCustomer(updated) } },
      "chargebee",
    );

    return c.json({ customer: formatCustomer(updated) });
  };

  app.post("/api/v2/customers/:id", update);
  app.post("/api/v2/customers/:id/update_billing_info", update);

  app.get("/api/v2/customers", (c) => {
    const filters = readFilters(c, ["id", "email", "company", "created_at"]);
    const rows = cs.customers
      .all()
      .filter((customer) =>
        matchesFilters(filters, (field) => (field === "id" ? customer.chargebee_id : fieldOf(customer, field))),
      )
      .sort((left, right) => left.created - right.created);

    return chargebeeList(c, rows, (customer) => ({ customer: formatCustomer(customer) }));
  });
}
