import type { Context, WebhookDispatcher } from "@emulators/core";
import type {
  ChargebeeInvoice,
  ChargebeeItemPrice,
  ChargebeeLineItem,
  ChargebeeSubscription,
  ChargebeeSubscriptionItem,
} from "./entities.js";
import { formatCustomer, formatInvoice, formatSubscription } from "./formatters.js";
import { addPeriod, chargebeeError, chargebeeId, monthsInPeriod, nextInvoiceNumber, now } from "./helpers.js";
import type { ChargebeeStore } from "./store.js";

/** Guards against a malformed billing period turning a time jump into a hang. */
const MAX_TERMS_PER_RUN = 2000;

/**
 * A failure that a route turns into a Chargebee-shaped error response.
 *
 * Billing logic lives away from HTTP so it can be reasoned about and tested on its
 * own, so it raises this instead of building a response.
 */
export class BillingError extends Error {
  constructor(
    public status: number,
    public apiErrorCode: string,
    message: string,
    public param?: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * Turn a BillingError into a Chargebee-shaped response, or return null when the
 * failure is something else and should keep propagating.
 */
export function billingErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof BillingError)) return null;
  return chargebeeError(
    c,
    error.status,
    error.apiErrorCode,
    error.message,
    error.status >= 500 ? "operation_failed" : "invalid_request",
    error.param,
  ) as unknown as Response;
}

export interface BillingContext {
  cs: ChargebeeStore;
  webhooks: WebhookDispatcher;
}

export interface RequestedItem {
  itemPriceId: string;
  quantity?: number;
  unitPrice?: number;
}

async function emit(ctx: BillingContext, eventType: string, content: Record<string, unknown>): Promise<void> {
  const at = now(ctx.cs);
  ctx.cs.events.insert({
    chargebee_id: chargebeeId("ev"),
    occurred_at: at,
    event_type: eventType,
    content,
    created: at,
    updated: at,
  });
  await ctx.webhooks.dispatch(
    eventType,
    undefined,
    { id: chargebeeId("ev"), event_type: eventType, content },
    "chargebee",
  );
}

export function itemPriceOrThrow(cs: ChargebeeStore, id: string): ChargebeeItemPrice {
  const price = cs.itemPrices.findOneBy("chargebee_id", id);
  if (!price) {
    throw new BillingError(404, "resource_not_found", `Item price [${id}] not found`, "item_price_id");
  }
  return price;
}

function lineAmount(price: ChargebeeItemPrice, quantity: number, unitPrice: number): number {
  if (price.pricing_model === "flat_fee") return unitPrice;
  return unitPrice * Math.max(0, quantity - price.free_quantity);
}

export function monthlyRecurringRevenue(
  items: readonly ChargebeeSubscriptionItem[],
  period: number,
  unit: ChargebeeSubscription["billing_period_unit"],
): number {
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const months = monthsInPeriod(period, unit);
  return months <= 0 ? 0 : Math.round(total / months);
}

export function buildItems(
  cs: ChargebeeStore,
  requested: readonly RequestedItem[],
): { items: ChargebeeSubscriptionItem[]; plan: ChargebeeItemPrice } {
  if (requested.length === 0) {
    throw new BillingError(400, "param_required", "subscription_items is required", "subscription_items");
  }

  const items: ChargebeeSubscriptionItem[] = [];
  const plans: ChargebeeItemPrice[] = [];

  for (const entry of requested) {
    const price = itemPriceOrThrow(cs, entry.itemPriceId);
    const quantity = entry.quantity ?? 1;
    const unitPrice = entry.unitPrice ?? price.price;
    if (price.item_type === "plan") plans.push(price);
    items.push({
      item_price_id: price.chargebee_id,
      item_type: price.item_type,
      quantity,
      unit_price: unitPrice,
      amount: lineAmount(price, quantity, unitPrice),
      free_quantity: price.free_quantity,
    });
  }

  const plan = plans[0];
  if (plans.length !== 1 || !plan) {
    throw new BillingError(
      400,
      "param_wrong_value",
      `A subscription requires exactly one plan item price, received ${plans.length}`,
      "subscription_items",
    );
  }

  return { items, plan };
}

function hasUsablePaymentSource(cs: ChargebeeStore, customerId: string): boolean {
  return cs.paymentSources.findBy("customer_id", customerId).some((source) => source.status === "valid");
}

export function generateInvoice(
  cs: ChargebeeStore,
  subscription: ChargebeeSubscription,
  termStart: number,
  termEnd: number,
  first: boolean,
): ChargebeeInvoice {
  const at = now(cs);
  const customer = cs.customers.findOneBy("chargebee_id", subscription.customer_id);

  const lineItems: ChargebeeLineItem[] = subscription.items.map((item) => {
    const price = cs.itemPrices.findOneBy("chargebee_id", item.item_price_id);
    return {
      id: chargebeeId("li"),
      date_from: termStart,
      date_to: termEnd,
      unit_amount: item.unit_price,
      quantity: item.quantity,
      amount: item.amount,
      pricing_model: price?.pricing_model ?? "per_unit",
      description: price?.name ?? item.item_price_id,
      entity_id: item.item_price_id,
    };
  });

  const subTotal = lineItems.reduce((sum, line) => sum + line.amount, 0);
  // Settled on the spot when a usable card exists. No gateway latency, no decline,
  // and no dunning: those depend on retry ladders this emulator does not reproduce.
  const settled =
    subTotal === 0 || (customer?.auto_collection !== "off" && hasUsablePaymentSource(cs, subscription.customer_id));
  const netTermDays = customer?.net_term_days ?? 0;

  const invoice = cs.invoices.insert({
    chargebee_id: nextInvoiceNumber(cs),
    customer_id: subscription.customer_id,
    subscription_id: subscription.chargebee_id,
    status: settled ? "paid" : "payment_due",
    date: at,
    due_date: at + netTermDays * 86400,
    net_term_days: netTermDays,
    currency_code: subscription.currency_code,
    line_items: lineItems,
    sub_total: subTotal,
    total: subTotal,
    amount_paid: settled ? subTotal : 0,
    amount_due: settled ? 0 : subTotal,
    first_invoice: first,
    created: at,
    updated: at,
  });

  if (!settled) {
    cs.subscriptions.update(subscription.id, { due_invoices_count: subscription.due_invoices_count + 1 });
  }

  return invoice;
}

export interface CreateSubscriptionInput {
  customerId: string;
  items: readonly RequestedItem[];
  startDate?: number;
  trialEnd?: number;
}

/**
 * Create a subscription and its first invoice without emitting events.
 *
 * Split out so seeding can build a starting world synchronously. Seeded state is a
 * precondition rather than something that happened, so it must not fire webhooks at
 * an application that is only just booting.
 */
export function materializeSubscription(
  cs: ChargebeeStore,
  input: CreateSubscriptionInput,
): { subscription: ChargebeeSubscription; invoice?: ChargebeeInvoice } {
  const at = now(cs);
  const { items, plan } = buildItems(cs, input.items);

  const trialEnd =
    input.trialEnd ??
    (plan.trial_period !== null && plan.trial_period > 0
      ? addPeriod(at, plan.trial_period, plan.trial_period_unit ?? "day")
      : undefined);
  const future = input.startDate !== undefined && input.startDate > at;

  let created = cs.subscriptions.insert({
    chargebee_id: chargebeeId("sub"),
    customer_id: input.customerId,
    currency_code: plan.currency_code,
    status: future ? "future" : trialEnd !== undefined ? "in_trial" : "active",
    billing_period: plan.period,
    billing_period_unit: plan.period_unit,
    items,
    current_term_start: null,
    current_term_end: null,
    next_billing_at: null,
    trial_start: null,
    trial_end: null,
    started_at: input.startDate ?? at,
    activated_at: null,
    cancelled_at: null,
    cancel_reason: null,
    due_invoices_count: 0,
    mrr: monthlyRecurringRevenue(items, plan.period, plan.period_unit),
    created: at,
    updated: at,
  });

  let invoice: ChargebeeInvoice | undefined;

  if (future) {
    created = cs.subscriptions.update(created.id, { next_billing_at: input.startDate ?? at }) ?? created;
  } else if (trialEnd !== undefined) {
    created =
      cs.subscriptions.update(created.id, { trial_start: at, trial_end: trialEnd, next_billing_at: trialEnd }) ??
      created;
  } else {
    const termEnd = addPeriod(at, plan.period, plan.period_unit);
    created =
      cs.subscriptions.update(created.id, {
        current_term_start: at,
        current_term_end: termEnd,
        next_billing_at: termEnd,
        activated_at: at,
      }) ?? created;
    invoice = generateInvoice(cs, created, at, termEnd, true);
    created = cs.subscriptions.get(created.id) ?? created;
  }

  return { subscription: created, invoice };
}

export async function createSubscription(
  ctx: BillingContext,
  input: CreateSubscriptionInput,
): Promise<{ subscription: ChargebeeSubscription; invoice?: ChargebeeInvoice }> {
  const { subscription, invoice } = materializeSubscription(ctx.cs, input);
  const customer = ctx.cs.customers.findOneBy("chargebee_id", input.customerId);

  await emit(ctx, "subscription_created", {
    subscription: formatSubscription(subscription),
    ...(customer ? { customer: formatCustomer(customer) } : {}),
    ...(invoice ? { invoice: formatInvoice(invoice) } : {}),
  });
  if (invoice) {
    await emit(ctx, "invoice_generated", { invoice: formatInvoice(invoice) });
  }

  return { subscription, invoice };
}

async function activateTerm(
  ctx: BillingContext,
  subscription: ChargebeeSubscription,
  start: number,
  first: boolean,
  eventType: "subscription_activated" | "subscription_renewed",
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  const termEnd = addPeriod(start, subscription.billing_period, subscription.billing_period_unit);
  const updated =
    cs.subscriptions.update(subscription.id, {
      status: "active",
      current_term_start: start,
      current_term_end: termEnd,
      next_billing_at: termEnd,
      ...(subscription.activated_at === null ? { activated_at: start } : {}),
      updated: now(cs),
    }) ?? subscription;

  const invoice = generateInvoice(cs, updated, start, termEnd, first);
  const settled = cs.subscriptions.get(updated.id) ?? updated;

  await emit(ctx, eventType, {
    subscription: formatSubscription(settled),
    invoice: formatInvoice(invoice),
  });
  await emit(ctx, "invoice_generated", { invoice: formatInvoice(invoice) });

  return settled;
}

/**
 * Run every transition the clock has made due.
 *
 * A caller who jumps a year forward gets the twelve renewals, twelve invoices and
 * twelve events that a year would really have produced, in order, rather than a
 * single leap to the final state. That ordering is the whole point: it is what makes
 * a year of billing behavior testable in a millisecond.
 */
export async function runDueWork(ctx: BillingContext): Promise<void> {
  const { cs } = ctx;
  const at = now(cs);

  for (const initial of cs.subscriptions.all()) {
    let subscription = initial;
    let guard = 0;

    for (;;) {
      guard += 1;
      if (guard > MAX_TERMS_PER_RUN) {
        throw new BillingError(
          500,
          "internal_error",
          `Subscription ${subscription.chargebee_id} did not settle within ${MAX_TERMS_PER_RUN} terms; check its billing period`,
        );
      }

      const due = subscription.next_billing_at;
      if (due === null || due > at) break;

      if (subscription.status === "future") {
        subscription = await activateTerm(ctx, subscription, due, true, "subscription_activated");
        continue;
      }
      if (subscription.status === "in_trial") {
        subscription = await activateTerm(
          ctx,
          subscription,
          subscription.trial_end ?? due,
          true,
          "subscription_activated",
        );
        continue;
      }
      if (subscription.status === "active") {
        subscription = await activateTerm(
          ctx,
          subscription,
          subscription.current_term_end ?? due,
          false,
          "subscription_renewed",
        );
        continue;
      }
      if (subscription.status === "non_renewing") {
        const ended =
          cs.subscriptions.update(subscription.id, {
            status: "cancelled",
            cancelled_at: subscription.current_term_end ?? at,
            next_billing_at: null,
            updated: at,
          }) ?? subscription;
        await emit(ctx, "subscription_cancelled", { subscription: formatSubscription(ended) });
        break;
      }
      break;
    }
  }
}

export async function cancelSubscription(
  ctx: BillingContext,
  subscription: ChargebeeSubscription,
  endOfTerm: boolean,
  reason: string | undefined,
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  if (subscription.status === "cancelled") {
    throw new BillingError(409, "invalid_state_for_request", "Subscription is already cancelled");
  }

  const at = now(cs);
  const scheduled = endOfTerm && subscription.current_term_end !== null;
  const updated =
    cs.subscriptions.update(subscription.id, {
      status: scheduled ? "non_renewing" : "cancelled",
      next_billing_at: scheduled ? subscription.current_term_end : null,
      ...(scheduled ? {} : { cancelled_at: at }),
      ...(reason !== undefined ? { cancel_reason: reason } : {}),
      updated: at,
    }) ?? subscription;

  await emit(ctx, scheduled ? "subscription_cancellation_scheduled" : "subscription_cancelled", {
    subscription: formatSubscription(updated),
  });

  return updated;
}

export async function reactivateSubscription(
  ctx: BillingContext,
  subscription: ChargebeeSubscription,
): Promise<{ subscription: ChargebeeSubscription; invoice?: ChargebeeInvoice }> {
  const { cs } = ctx;
  const at = now(cs);

  if (subscription.status === "non_renewing") {
    const updated =
      cs.subscriptions.update(subscription.id, { status: "active", cancelled_at: null, updated: at }) ?? subscription;
    await emit(ctx, "subscription_reactivated", { subscription: formatSubscription(updated) });
    return { subscription: updated };
  }

  if (subscription.status !== "cancelled") {
    throw new BillingError(
      409,
      "invalid_state_for_request",
      `Only a cancelled or non-renewing subscription can be reactivated, this one is ${subscription.status}`,
    );
  }

  const termEnd = addPeriod(at, subscription.billing_period, subscription.billing_period_unit);
  let updated =
    cs.subscriptions.update(subscription.id, {
      status: "active",
      cancelled_at: null,
      cancel_reason: null,
      current_term_start: at,
      current_term_end: termEnd,
      next_billing_at: termEnd,
      activated_at: at,
      updated: at,
    }) ?? subscription;

  const invoice = generateInvoice(cs, updated, at, termEnd, false);
  updated = cs.subscriptions.get(updated.id) ?? updated;

  await emit(ctx, "subscription_reactivated", {
    subscription: formatSubscription(updated),
    invoice: formatInvoice(invoice),
  });
  await emit(ctx, "invoice_generated", { invoice: formatInvoice(invoice) });

  return { subscription: updated, invoice };
}

/**
 * Replace a subscription's items.
 *
 * An unprorated change is fully determined by the request, so it is reproduced. A
 * prorated one is not: the credit and charge arithmetic is not publicly specified,
 * and inventing it would produce passing tests over numbers the real API computes
 * differently. So the prorated path refuses instead of approximating.
 */
export async function updateSubscriptionItems(
  ctx: BillingContext,
  subscription: ChargebeeSubscription,
  requested: readonly RequestedItem[],
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  if (subscription.status === "cancelled") {
    throw new BillingError(409, "invalid_state_for_request", "Cannot update a cancelled subscription");
  }

  const { items, plan } = buildItems(cs, requested);
  const updated =
    cs.subscriptions.update(subscription.id, {
      items,
      billing_period: plan.period,
      billing_period_unit: plan.period_unit,
      currency_code: plan.currency_code,
      mrr: monthlyRecurringRevenue(items, plan.period, plan.period_unit),
      updated: now(cs),
    }) ?? subscription;

  await emit(ctx, "subscription_changed", { subscription: formatSubscription(updated) });
  return updated;
}
