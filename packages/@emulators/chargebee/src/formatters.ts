import type {
  ChargebeeCustomer,
  ChargebeeEvent,
  ChargebeeInvoice,
  ChargebeeItem,
  ChargebeeItemFamily,
  ChargebeeItemPrice,
  ChargebeePaymentSource,
  ChargebeeSubscription,
} from "./entities.js";

/**
 * Chargebee omits absent optional fields rather than sending nulls for them, so
 * responses are assembled with a helper that drops undefined and leaves explicit
 * nulls alone.
 */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function orUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/** Chargebee's optimistic-concurrency stamp is millisecond resolution. */
function resourceVersion(updated: number): number {
  return updated * 1000;
}

export function formatCustomer(customer: ChargebeeCustomer): Record<string, unknown> {
  return compact({
    id: customer.chargebee_id,
    object: "customer",
    first_name: orUndefined(customer.first_name),
    last_name: orUndefined(customer.last_name),
    email: orUndefined(customer.email),
    company: orUndefined(customer.company),
    phone: orUndefined(customer.phone),
    locale: orUndefined(customer.locale),
    auto_collection: customer.auto_collection,
    net_term_days: customer.net_term_days,
    allow_direct_debit: false,
    taxability: "taxable",
    pii_cleared: "active",
    channel: "web",
    card_status: customer.card_status,
    primary_payment_source_id: orUndefined(customer.primary_payment_source_id),
    promotional_credits: 0,
    refundable_credits: 0,
    excess_payments: 0,
    unbilled_charges: 0,
    preferred_currency_code: customer.preferred_currency_code,
    billing_address: customer.billing_address
      ? compact({ ...customer.billing_address, validation_status: "not_validated", object: "billing_address" })
      : undefined,
    meta_data: Object.keys(customer.meta_data).length > 0 ? customer.meta_data : undefined,
    ...customer.cf_fields,
    created_at: customer.created,
    updated_at: customer.updated,
    resource_version: resourceVersion(customer.updated),
    deleted: false,
  });
}

export function formatItemFamily(family: ChargebeeItemFamily): Record<string, unknown> {
  return compact({
    id: family.chargebee_id,
    object: "item_family",
    name: family.name,
    status: "active",
    updated_at: family.updated,
    resource_version: resourceVersion(family.updated),
  });
}

export function formatItem(item: ChargebeeItem): Record<string, unknown> {
  return compact({
    id: item.chargebee_id,
    object: "item",
    name: item.name,
    external_name: orUndefined(item.external_name),
    type: item.type,
    item_family_id: item.item_family_id,
    status: "active",
    is_shippable: false,
    is_giftable: false,
    enabled_for_checkout: true,
    enabled_in_portal: true,
    metered: item.metered,
    updated_at: item.updated,
    resource_version: resourceVersion(item.updated),
  });
}

export function formatItemPrice(price: ChargebeeItemPrice): Record<string, unknown> {
  return compact({
    id: price.chargebee_id,
    object: "item_price",
    name: price.name,
    external_name: orUndefined(price.external_name),
    item_family_id: price.item_family_id,
    item_id: price.item_id,
    item_type: price.item_type,
    status: "active",
    pricing_model: price.pricing_model,
    price: price.price,
    period: price.period,
    period_unit: price.period_unit,
    free_quantity: price.free_quantity,
    currency_code: price.currency_code,
    trial_period: orUndefined(price.trial_period),
    trial_period_unit: orUndefined(price.trial_period_unit),
    channel: "web",
    is_taxable: false,
    created_at: price.created,
    updated_at: price.updated,
    resource_version: resourceVersion(price.updated),
  });
}

export function formatSubscription(subscription: ChargebeeSubscription): Record<string, unknown> {
  return compact({
    id: subscription.chargebee_id,
    object: "subscription",
    customer_id: subscription.customer_id,
    currency_code: subscription.currency_code,
    status: subscription.status,
    billing_period: subscription.billing_period,
    billing_period_unit: subscription.billing_period_unit,
    subscription_items: subscription.items.map((item) => ({
      item_price_id: item.item_price_id,
      item_type: item.item_type,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      free_quantity: item.free_quantity,
      object: "subscription_item",
    })),
    current_term_start: orUndefined(subscription.current_term_start),
    current_term_end: orUndefined(subscription.current_term_end),
    next_billing_at: orUndefined(subscription.next_billing_at),
    trial_start: orUndefined(subscription.trial_start),
    trial_end: orUndefined(subscription.trial_end),
    started_at: subscription.started_at,
    activated_at: orUndefined(subscription.activated_at),
    cancelled_at: orUndefined(subscription.cancelled_at),
    cancel_reason: orUndefined(subscription.cancel_reason),
    has_scheduled_changes: false,
    due_invoices_count: subscription.due_invoices_count,
    mrr: subscription.mrr,
    created_at: subscription.created,
    updated_at: subscription.updated,
    resource_version: resourceVersion(subscription.updated),
    deleted: false,
  });
}

export function formatInvoice(invoice: ChargebeeInvoice): Record<string, unknown> {
  return compact({
    id: invoice.chargebee_id,
    object: "invoice",
    customer_id: invoice.customer_id,
    subscription_id: orUndefined(invoice.subscription_id),
    recurring: true,
    status: invoice.status,
    price_type: "tax_exclusive",
    date: invoice.date,
    due_date: invoice.due_date,
    net_term_days: invoice.net_term_days,
    currency_code: invoice.currency_code,
    line_items: invoice.line_items.map((line) => ({
      id: line.id,
      date_from: line.date_from,
      date_to: line.date_to,
      unit_amount: line.unit_amount,
      quantity: line.quantity,
      amount: line.amount,
      pricing_model: line.pricing_model,
      is_taxed: false,
      tax_amount: 0,
      discount_amount: 0,
      item_level_discount_amount: 0,
      description: line.description,
      entity_type: "item_price",
      entity_id: line.entity_id,
      subscription_id: orUndefined(invoice.subscription_id),
      customer_id: invoice.customer_id,
      object: "line_item",
    })),
    sub_total: invoice.sub_total,
    tax: 0,
    total: invoice.total,
    amount_paid: invoice.amount_paid,
    amount_adjusted: 0,
    write_off_amount: 0,
    credits_applied: 0,
    amount_due: invoice.amount_due,
    first_invoice: invoice.first_invoice,
    has_advance_charges: false,
    term_finalized: true,
    is_gifted: false,
    dunning_attempts: [],
    generated_at: invoice.date,
    updated_at: invoice.updated,
    resource_version: resourceVersion(invoice.updated),
    deleted: false,
  });
}

export function formatPaymentSource(source: ChargebeePaymentSource): Record<string, unknown> {
  return compact({
    id: source.chargebee_id,
    object: "payment_source",
    customer_id: source.customer_id,
    type: "card",
    status: source.status,
    gateway: "chargebee",
    gateway_account_id: "gw_emulator",
    reference_id: source.reference_id,
    card: source.card ? compact({ ...source.card, funding_type: "credit", object: "card" }) : undefined,
    created_at: source.created,
    updated_at: source.updated,
    resource_version: resourceVersion(source.updated),
    deleted: false,
  });
}

export function formatEvent(event: ChargebeeEvent): Record<string, unknown> {
  return compact({
    id: event.chargebee_id,
    object: "event",
    occurred_at: event.occurred_at,
    source: "api",
    event_type: event.event_type,
    api_version: "v2",
    content: event.content,
    webhook_status: "not_applicable",
  });
}
