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
  readonly created: number;
  readonly updated: number;
}

/**
 * A mutable partial of a stored row, for assembling an update.
 *
 * Rows are readonly so that nothing can edit one in place behind the store's back;
 * a patch is built here and handed to `Collection.update`, which is the only way
 * state changes.
 */
export type Draft<T> = { -readonly [K in keyof T]?: T[K] };

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
  readonly now: number;
  readonly invoice_seq: number;
}

export interface ChargebeeBillingAddress {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly state_code?: string;
  readonly country?: string;
  readonly zip?: string;
}

export interface ChargebeeCustomer extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly phone: string | null;
  readonly locale: string | null;
  readonly auto_collection: "on" | "off";
  readonly net_term_days: number;
  readonly preferred_currency_code: string;
  readonly card_status: "no_card" | "valid" | "expiring" | "expired";
  readonly primary_payment_source_id: string | null;
  readonly billing_address: ChargebeeBillingAddress | null;
  readonly meta_data: Record<string, unknown>;
  readonly cf_fields: Record<string, string>;
}

export interface ChargebeeItemFamily extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly name: string;
}

export interface ChargebeeItem extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly name: string;
  readonly external_name: string | null;
  readonly type: ItemType;
  readonly item_family_id: string;
  readonly metered: boolean;
}

export interface ChargebeeItemPrice extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly name: string;
  readonly external_name: string | null;
  readonly item_family_id: string;
  readonly item_id: string;
  readonly item_type: ItemType;
  readonly pricing_model: PricingModel;
  readonly price: number;
  readonly period: number;
  readonly period_unit: PeriodUnit;
  readonly free_quantity: number;
  readonly currency_code: string;
  readonly trial_period: number | null;
  readonly trial_period_unit: PeriodUnit | null;
}

export interface ChargebeeSubscriptionItem {
  readonly item_price_id: string;
  readonly item_type: ItemType;
  readonly quantity: number;
  readonly unit_price: number;
  readonly amount: number;
  readonly free_quantity: number;
}

export interface ChargebeeSubscription extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly customer_id: string;
  readonly currency_code: string;
  readonly status: SubscriptionStatus;
  readonly billing_period: number;
  readonly billing_period_unit: PeriodUnit;
  readonly items: readonly ChargebeeSubscriptionItem[];
  readonly current_term_start: number | null;
  readonly current_term_end: number | null;
  readonly next_billing_at: number | null;
  readonly trial_start: number | null;
  readonly trial_end: number | null;
  readonly started_at: number;
  readonly activated_at: number | null;
  readonly cancelled_at: number | null;
  readonly cancel_reason: string | null;
  readonly due_invoices_count: number;
  readonly mrr: number;
}

export interface ChargebeeLineItem {
  readonly id: string;
  readonly date_from: number;
  readonly date_to: number;
  readonly unit_amount: number;
  readonly quantity: number;
  readonly amount: number;
  readonly pricing_model: PricingModel;
  readonly description: string;
  readonly entity_id: string;
}

export interface ChargebeeInvoice extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly customer_id: string;
  readonly subscription_id: string | null;
  readonly status: InvoiceStatus;
  readonly date: number;
  readonly due_date: number;
  readonly net_term_days: number;
  readonly currency_code: string;
  readonly line_items: readonly ChargebeeLineItem[];
  readonly sub_total: number;
  readonly total: number;
  readonly amount_paid: number;
  readonly amount_due: number;
  readonly first_invoice: boolean;
}

export interface ChargebeeCard {
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly iin: string;
  readonly last4: string;
  readonly brand: string;
  readonly expiry_month: number;
  readonly expiry_year: number;
  readonly masked_number: string;
}

export interface ChargebeePaymentSource extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly customer_id: string;
  readonly status: "valid" | "expiring" | "expired" | "invalid";
  readonly reference_id: string;
  readonly card: ChargebeeCard | null;
}

export interface ChargebeeEvent extends Entity, Timestamped {
  readonly chargebee_id: string;
  readonly occurred_at: number;
  readonly event_type: string;
  readonly content: Record<string, unknown>;
}
