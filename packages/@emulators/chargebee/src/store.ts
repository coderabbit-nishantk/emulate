import { Store, type Collection, type CollectionSnapshot, type Entity } from "@emulators/core";
import type {
  ChargebeeCustomer,
  ChargebeeEvent,
  ChargebeeInvoice,
  ChargebeeItem,
  ChargebeeItemFamily,
  ChargebeeItemPrice,
  ChargebeeMeta,
  ChargebeePaymentSource,
  ChargebeeSubscription,
} from "./entities.js";

export interface ChargebeeStore {
  readonly meta: Collection<ChargebeeMeta>;
  readonly customers: Collection<ChargebeeCustomer>;
  readonly itemFamilies: Collection<ChargebeeItemFamily>;
  readonly items: Collection<ChargebeeItem>;
  readonly itemPrices: Collection<ChargebeeItemPrice>;
  readonly subscriptions: Collection<ChargebeeSubscription>;
  readonly invoices: Collection<ChargebeeInvoice>;
  readonly paymentSources: Collection<ChargebeePaymentSource>;
  readonly events: Collection<ChargebeeEvent>;
}

export function getChargebeeStore(store: Store): ChargebeeStore {
  return {
    meta: store.collection<ChargebeeMeta>("chargebee.meta", []),
    customers: store.collection<ChargebeeCustomer>("chargebee.customers", ["chargebee_id", "email"]),
    itemFamilies: store.collection<ChargebeeItemFamily>("chargebee.item_families", ["chargebee_id"]),
    items: store.collection<ChargebeeItem>("chargebee.items", ["chargebee_id", "item_family_id"]),
    itemPrices: store.collection<ChargebeeItemPrice>("chargebee.item_prices", ["chargebee_id", "item_id", "item_type"]),
    subscriptions: store.collection<ChargebeeSubscription>("chargebee.subscriptions", [
      "chargebee_id",
      "customer_id",
      "status",
    ]),
    invoices: store.collection<ChargebeeInvoice>("chargebee.invoices", [
      "chargebee_id",
      "customer_id",
      "subscription_id",
    ]),
    paymentSources: store.collection<ChargebeePaymentSource>("chargebee.payment_sources", [
      "chargebee_id",
      "customer_id",
    ]),
    events: store.collection<ChargebeeEvent>("chargebee.events", ["chargebee_id", "event_type"]),
  };
}

/**
 * A point-in-time copy of this emulator's own collections.
 *
 * Deliberately not `Store.snapshot()`: the core store is shared by every service
 * plugin registered on the same server, so restoring the whole store to undo a
 * Chargebee operation would also roll back GitHub, Stripe and anything else
 * running alongside it.
 */
export interface ChargebeeSnapshot {
  readonly collections: ReadonlyArray<{
    readonly collection: Collection<never>;
    readonly snapshot: CollectionSnapshot<never>;
  }>;
}

function collectionsOf(cs: ChargebeeStore): ReadonlyArray<Collection<never>> {
  // Cast through Entity because the collections hold different row types; only
  // snapshot and restore are used, and both are row-type agnostic.
  const all: ReadonlyArray<Collection<Entity>> = [
    cs.meta,
    cs.customers,
    cs.itemFamilies,
    cs.items,
    cs.itemPrices,
    cs.subscriptions,
    cs.invoices,
    cs.paymentSources,
    cs.events,
  ];
  return all as ReadonlyArray<Collection<never>>;
}

export function snapshotChargebee(cs: ChargebeeStore): ChargebeeSnapshot {
  return {
    collections: collectionsOf(cs).map((collection) => ({ collection, snapshot: collection.snapshot() })),
  };
}

export function restoreChargebee(snapshot: ChargebeeSnapshot): void {
  for (const { collection, snapshot: rows } of snapshot.collections) {
    collection.restore(rows);
  }
}
