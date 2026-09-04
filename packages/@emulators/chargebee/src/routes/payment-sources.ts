import type { RouteContext } from "@emulators/core";
import { formatCustomer, formatPaymentSource } from "../formatters.js";
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

function brandFor(number: string): string {
  if (number.startsWith("4")) return "visa";
  if (number.startsWith("34") || number.startsWith("37")) return "american_express";
  if (number.startsWith("6")) return "discover";
  return "mastercard";
}

export function paymentSourceRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.post("/api/v2/payment_sources/create_card", async (c) => {
    const body = await parseChargebeeBody(c);
    const customerId = readString(body, "customer_id");
    if (!customerId) {
      return chargebeeError(c, 400, "param_required", "customer_id is required", "invalid_request", "customer_id");
    }

    const customer = cs.customers.findOneBy("chargebee_id", customerId);
    if (!customer) return notFound(c);

    const card = readGroup(body, "card");
    const number = readString(card, "number") ?? "4111111111111111";
    const at = now(cs);

    // No gateway, so no card is ever declined. Metadata is derived from the number
    // that was supplied rather than validated against anything.
    const source = cs.paymentSources.insert({
      chargebee_id: chargebeeId("pm"),
      customer_id: customerId,
      status: "valid",
      reference_id: chargebeeId("ref"),
      card: {
        first_name: readString(card, "first_name") ?? null,
        last_name: readString(card, "last_name") ?? null,
        iin: number.slice(0, 6),
        last4: number.slice(-4),
        brand: brandFor(number),
        expiry_month: readNumber(card, "expiry_month") ?? 12,
        expiry_year: readNumber(card, "expiry_year") ?? 2030,
        masked_number: `${"*".repeat(Math.max(0, number.length - 4))}${number.slice(-4)}`,
      },
      created: at,
      updated: at,
    });

    const updatedCustomer =
      cs.customers.update(customer.id, {
        card_status: "valid",
        primary_payment_source_id: customer.primary_payment_source_id ?? source.chargebee_id,
        updated: at,
      }) ?? customer;

    await webhooks.dispatch(
      "payment_source_added",
      undefined,
      {
        event_type: "payment_source_added",
        content: { payment_source: formatPaymentSource(source), customer: formatCustomer(updatedCustomer) },
      },
      "chargebee",
    );

    return c.json({ payment_source: formatPaymentSource(source), customer: formatCustomer(updatedCustomer) });
  });

  app.get("/api/v2/payment_sources/:id", (c) => {
    const source = cs.paymentSources.findOneBy("chargebee_id", c.req.param("id"));
    if (!source) return notFound(c);
    return c.json({ payment_source: formatPaymentSource(source) });
  });

  app.get("/api/v2/payment_sources", (c) => {
    const filters = readFilters(c, ["id", "customer_id", "status", "type"]);
    const rows = cs.paymentSources
      .all()
      .filter((source) =>
        matchesFilters(filters, (field) => (field === "id" ? source.chargebee_id : fieldOf(source, field))),
      )
      .sort((left, right) => left.created - right.created);

    return chargebeeList(c, rows, (source) => ({ payment_source: formatPaymentSource(source) }));
  });

  app.post("/api/v2/payment_sources/:id/delete", async (c) => {
    const source = cs.paymentSources.findOneBy("chargebee_id", c.req.param("id"));
    if (!source) return notFound(c);

    cs.paymentSources.delete(source.id);

    const customer = cs.customers.findOneBy("chargebee_id", source.customer_id);
    if (customer) {
      const remaining = cs.paymentSources
        .findBy("customer_id", customer.chargebee_id)
        .some((other) => other.status === "valid");
      cs.customers.update(customer.id, {
        card_status: remaining ? "valid" : "no_card",
        primary_payment_source_id:
          customer.primary_payment_source_id === source.chargebee_id ? null : customer.primary_payment_source_id,
        updated: now(cs),
      });
    }

    await webhooks.dispatch(
      "payment_source_deleted",
      undefined,
      { event_type: "payment_source_deleted", content: { payment_source: formatPaymentSource(source) } },
      "chargebee",
    );

    return c.json({ payment_source: { ...formatPaymentSource(source), deleted: true } });
  });
}
