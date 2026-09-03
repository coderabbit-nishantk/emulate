import type { Entity } from "@emulators/core";

/**
 * Emulator-clock timestamps, in unix seconds.
 *
 * `Entity` already carries `created_at`/`updated_at`, but those are ISO strings
 * stamped from the wall clock by the core store. Chargebee exposes unix seconds and,
 * more importantly, this emulator's clock is a caller-controlled input, so anything
 * a response exposes has to be derived from that clock rather than from real time.
 */
interface Timestamped {
  created: number;
  updated: number;
}

export type PeriodUnit = "day" | "week" | "month" | "year";

export type ItemType = "plan" | "addon" | "charge";

export type PricingModel = "per_unit" | "flat_fee";

export type SubscriptionStatus = "future" | "in_trial" | "active" | "non_renewing" | "paused" | "cancelled";

export type InvoiceStatus = "paid" | "posted" | "payment_due" | "not_paid" | "voided" | "pending";

/**
 * Emulator-wide singleton row.
 *
 * The clock lives in the store rather than in module state so that it takes part in
 * snapshot and restore, and so a caller advancing time can never be surprised by a
 * wall clock reading underneath it. Invoice numbers are sequential because that is
 * what Chargebee itself generates.
 */
export interface ChargebeeMeta extends Entity {
  now: number;
  invoice_seq: number;
}

export interface ChargebeeBillingAddress {
  first_name?: string;
  last_name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  state_code?: string;
  country?: string;
  zip?: string;
}

export interface ChargebeeCustomer extends Entity, Timestamped {
  chargebee_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  phone: string | null;
  locale: string | null;
  auto_collection: "on" | "off";
  net_term_days: number;
  preferred_currency_code: string;
  card_status: "no_card" | "valid" | "expiring" | "expired";
  primary_payment_source_id: string | null;
  billing_address: ChargebeeBillingAddress | null;
  meta_data: Record<string, unknown>;
  cf_fields: Record<string, string>;
}

export interface ChargebeeItemFamily extends Entity, Timestamped {
  chargebee_id: string;
  name: string;
}

export interface ChargebeeItem extends Entity, Timestamped {
  chargebee_id: string;
  name: string;
  external_name: string | null;
  type: ItemType;
  item_family_id: string;
  metered: boolean;
}

export interface ChargebeeItemPrice extends Entity, Timestamped {
  chargebee_id: string;
  name: string;
  external_name: string | null;
  item_family_id: string;
  item_id: string;
  item_type: ItemType;
  pricing_model: PricingModel;
  price: number;
  period: number;
  period_unit: PeriodUnit;
  free_quantity: number;
  currency_code: string;
  trial_period: number | null;
  trial_period_unit: PeriodUnit | null;
}

export interface ChargebeeSubscriptionItem {
  item_price_id: string;
  item_type: ItemType;
  quantity: number;
  unit_price: number;
  amount: number;
  free_quantity: number;
}

export interface ChargebeeSubscription extends Entity, Timestamped {
  chargebee_id: string;
  customer_id: string;
  currency_code: string;
  status: SubscriptionStatus;
  billing_period: number;
  billing_period_unit: PeriodUnit;
  items: ChargebeeSubscriptionItem[];
  current_term_start: number | null;
  current_term_end: number | null;
  next_billing_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  started_at: number;
  activated_at: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
  due_invoices_count: number;
  mrr: number;
}

export interface ChargebeeLineItem {
  id: string;
  date_from: number;
  date_to: number;
  unit_amount: number;
  quantity: number;
  amount: number;
  pricing_model: PricingModel;
  description: string;
  entity_id: string;
}

export interface ChargebeeInvoice extends Entity, Timestamped {
  chargebee_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: InvoiceStatus;
  date: number;
  due_date: number;
  net_term_days: number;
  currency_code: string;
  line_items: ChargebeeLineItem[];
  sub_total: number;
  total: number;
  amount_paid: number;
  amount_due: number;
  first_invoice: boolean;
}

export interface ChargebeeCard {
  first_name: string | null;
  last_name: string | null;
  iin: string;
  last4: string;
  brand: string;
  expiry_month: number;
  expiry_year: number;
  masked_number: string;
}

export interface ChargebeePaymentSource extends Entity, Timestamped {
  chargebee_id: string;
  customer_id: string;
  status: "valid" | "expiring" | "expired" | "invalid";
  reference_id: string;
  card: ChargebeeCard | null;
}

export interface ChargebeeEvent extends Entity, Timestamped {
  chargebee_id: string;
  occurred_at: number;
  event_type: string;
  content: Record<string, unknown>;
}
