import type { RouteContext } from "@emulators/core";
import {
  cancelSubscription,
  createSubscription,
  reactivateSubscription,
  type RequestedItem,
  updateSubscriptionItems,
} from "../billing.js";
import { formatCustomer, formatInvoice, formatSubscription } from "../formatters.js";
import {
  badParam,
  chargebeeList,
  fieldOf,
  invalidState,
  matchesFilters,
  missingParam,
  notEmulated,
  notFound,
  now,
  parseChargebeeBody,
  readBoolean,
  readFilters,
  readIndexed,
  readNumber,
  readString,
} from "../helpers.js";
import { getChargebeeStore } from "../store.js";

function requestedItems(body: Record<string, unknown>): RequestedItem[] {
  return readIndexed(body, "subscription_items").map((row) => ({
    itemPriceId: row.item_price_id ?? "",
    quantity: row.quantity === undefined ? undefined : Number(row.quantity),
    unitPrice: row.unit_price === undefined ? undefined : Number(row.unit_price),
  }));
}

/**
 * Coupons and discounts are refused rather than ignored.
 *
 * Silently dropping a coupon would be worse than failing: the subscription would be
 * created at full price and the caller would have no signal that the discount never
 * applied.
 */
function discountRequested(body: Record<string, unknown>): boolean {
  return body.coupon_ids !== undefined || body.coupon !== undefined || readIndexed(body, "discounts").length > 0;
}

export function subscriptionRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getChargebeeStore(store);
  const ctx = { cs, webhooks };

  app.post("/api/v2/customers/:id/subscription_for_items", async (c) => {
    const customer = cs.customers.findOneBy("chargebee_id", c.req.param("id"));
    if (!customer) return notFound(c);

    const body = await parseChargebeeBody(c);
    if (discountRequested(body)) {
      return notEmulated(c, "coupons and discounts", "stacking rules and application order are not publicly specified");
    }

    const { subscription, invoice } = await createSubscription(ctx, {
      customerId: customer.chargebee_id,
      items: requestedItems(body),
      startDate: readNumber(body, "start_date"),
      trialEnd: readNumber(body, "trial_end"),
    });

    const refreshed = cs.customers.findOneBy("chargebee_id", customer.chargebee_id) ?? customer;
    return c.json({
      subscription: formatSubscription(subscription),
      customer: formatCustomer(refreshed),
      ...(invoice ? { invoice: formatInvoice(invoice) } : {}),
    });
  });

  app.get("/api/v2/subscriptions/:id", (c) => {
    const subscription = cs.subscriptions.findOneBy("chargebee_id", c.req.param("id"));
    if (!subscription) return notFound(c);
    const customer = cs.customers.findOneBy("chargebee_id", subscription.customer_id);
    return c.json({
      subscription: formatSubscription(subscription),
      ...(customer ? { customer: formatCustomer(customer) } : {}),
    });
  });

  app.get("/api/v2/subscriptions", (c) => {
    const filters = readFilters(c, ["id", "customer_id", "status", "item_price_id"]);
    const rows = cs.subscriptions
      .all()
      .filter((subscription) =>
        matchesFilters(filters, (field) => {
          if (field === "id") return subscription.chargebee_id;
          if (field === "item_price_id") return subscription.items.map((item) => item.item_price_id).join(",");
          return fieldOf(subscription, field);
        }),
      )
      .sort((left, right) => left.created - right.created);

    return chargebeeList(c, rows, (subscription) => {
      const customer = cs.customers.findOneBy("chargebee_id", subscription.customer_id);
      return {
        subscription: formatSubscription(subscription),
        ...(customer ? { customer: formatCustomer(customer) } : {}),
      };
    });
  });

  app.post("/api/v2/subscriptions/:id/update_for_items", async (c) => {
    const subscription = cs.subscriptions.findOneBy("chargebee_id", c.req.param("id"));
    if (!subscription) return notFound(c);

    const body = await parseChargebeeBody(c);
    if (discountRequested(body)) {
      return notEmulated(c, "coupons and discounts", "stacking rules and application order are not publicly specified");
    }
    if (readBoolean(body, "prorate") === true) {
      return notEmulated(
        c,
        "subscription update with prorate=true",
        "proration credit and charge arithmetic is not publicly specified",
      );
    }

    const updated = await updateSubscriptionItems(ctx, subscription, requestedItems(body));
    const customer = cs.customers.findOneBy("chargebee_id", updated.customer_id);
    return c.json({
      subscription: formatSubscription(updated),
      ...(customer ? { customer: formatCustomer(customer) } : {}),
    });
  });

  app.post("/api/v2/subscriptions/:id/cancel_for_items", async (c) => {
    const subscription = cs.subscriptions.findOneBy("chargebee_id", c.req.param("id"));
    if (!subscription) return notFound(c);

    const body = await parseChargebeeBody(c);
    const cancelled = await cancelSubscription(
      ctx,
      subscription,
      readBoolean(body, "end_of_term") ?? false,
      readString(body, "cancel_reason_code"),
    );
    const customer = cs.customers.findOneBy("chargebee_id", cancelled.customer_id);
    return c.json({
      subscription: formatSubscription(cancelled),
      ...(customer ? { customer: formatCustomer(customer) } : {}),
    });
  });

  app.post("/api/v2/subscriptions/:id/reactivate", async (c) => {
    const subscription = cs.subscriptions.findOneBy("chargebee_id", c.req.param("id"));
    if (!subscription) return notFound(c);

    const result = await reactivateSubscription(ctx, subscription);
    const customer = cs.customers.findOneBy("chargebee_id", result.subscription.customer_id);
    return c.json({
      subscription: formatSubscription(result.subscription),
      ...(customer ? { customer: formatCustomer(customer) } : {}),
      ...(result.invoice ? { invoice: formatInvoice(result.invoice) } : {}),
    });
  });

  app.post("/api/v2/subscriptions/:id/change_term_end", async (c) => {
    const subscription = cs.subscriptions.findOneBy("chargebee_id", c.req.param("id"));
    if (!subscription) return notFound(c);

    const body = await parseChargebeeBody(c);
    const termEndsAt = readNumber(body, "term_ends_at");
    if (termEndsAt === undefined) throw missingParam("term_ends_at");

    if (subscription.status !== "active" && subscription.status !== "in_trial") {
      return invalidState(c, `Cannot change the term end of a ${subscription.status} subscription`);
    }

    // A past value would leave the subscription with an already-elapsed billing date,
    // so the next time jump would bill the term immediately. A value before the term
    // start would produce a negative term.
    const at = now(cs);
    if (termEndsAt <= at) {
      throw badParam("term_ends_at", "term_ends_at must be in the future");
    }
    if (subscription.current_term_start !== null && termEndsAt <= subscription.current_term_start) {
      throw badParam("term_ends_at", "term_ends_at must be after the current term start");
    }

    const updated = cs.subscriptions.update(subscription.id, {
      current_term_end: termEndsAt,
      next_billing_at: termEndsAt,
      updated: at,
    });
    if (!updated) return notFound(c);

    const customer = cs.customers.findOneBy("chargebee_id", updated.customer_id);
    return c.json({
      subscription: formatSubscription(updated),
      ...(customer ? { customer: formatCustomer(customer) } : {}),
    });
  });
}
