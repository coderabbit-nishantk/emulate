import { Store, type Collection } from "@emulators/core";
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
  meta: Collection<ChargebeeMeta>;
  customers: Collection<ChargebeeCustomer>;
  itemFamilies: Collection<ChargebeeItemFamily>;
  items: Collection<ChargebeeItem>;
  itemPrices: Collection<ChargebeeItemPrice>;
  subscriptions: Collection<ChargebeeSubscription>;
  invoices: Collection<ChargebeeInvoice>;
  paymentSources: Collection<ChargebeePaymentSource>;
  events: Collection<ChargebeeEvent>;
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
