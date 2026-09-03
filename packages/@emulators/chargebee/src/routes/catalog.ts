import type { RouteContext } from "@emulators/core";
import { formatItem, formatItemFamily, formatItemPrice } from "../formatters.js";
import {
  asItemType,
  asPeriodUnit,
  asPricingModel,
  badParam,
  chargebeeList,
  duplicate,
  fieldOf,
  matchesFilters,
  missingParam,
  notEmulated,
  notFound,
  now,
  parseChargebeeBody,
  readBoolean,
  readFilters,
  readNumber,
  readString,
} from "../helpers.js";
import { getChargebeeStore } from "../store.js";

export function catalogRoutes({ app, store }: RouteContext): void {
  const cs = getChargebeeStore(store);

  // -- Item families ------------------------------------------------------

  app.post("/api/v2/item_families", async (c) => {
    const body = await parseChargebeeBody(c);
    const id = readString(body, "id");
    if (!id) throw missingParam("id");

    if (cs.itemFamilies.findOneBy("chargebee_id", id)) {
      return duplicate(c, `Item family [${id}] already exists`);
    }

    const at = now(cs);
    const family = cs.itemFamilies.insert({
      chargebee_id: id,
      name: readString(body, "name") ?? id,
      created: at,
      updated: at,
    });
    return c.json({ item_family: formatItemFamily(family) });
  });

  app.get("/api/v2/item_families/:id", (c) => {
    const family = cs.itemFamilies.findOneBy("chargebee_id", c.req.param("id"));
    if (!family) return notFound(c);
    return c.json({ item_family: formatItemFamily(family) });
  });

  app.get("/api/v2/item_families", (c) => {
    const rows = cs.itemFamilies.all().sort((left, right) => left.created - right.created);
    return chargebeeList(c, rows, (family) => ({ item_family: formatItemFamily(family) }));
  });

  // -- Items -------------------------------------------------------------

  app.post("/api/v2/items", async (c) => {
    const body = await parseChargebeeBody(c);
    const id = readString(body, "id");
    const familyId = readString(body, "item_family_id");
    const rawType = readString(body, "type");

    if (!id) throw missingParam("id");
    if (!familyId) throw missingParam("item_family_id");
    if (!rawType) throw missingParam("type");

    const type = asItemType(rawType);
    if (!type) throw badParam("type", `Unknown item type: ${rawType}`);

    // The store's indexes are not unique, so a duplicate would leave retrieval
    // returning the first row while list returned both.
    if (cs.items.findOneBy("chargebee_id", id)) {
      return duplicate(c, `Item [${id}] already exists`);
    }
    if (!cs.itemFamilies.findOneBy("chargebee_id", familyId)) {
      return notFound(c, `Item family [${familyId}] not found`);
    }

    const at = now(cs);
    const item = cs.items.insert({
      chargebee_id: id,
      name: readString(body, "name") ?? id,
      external_name: readString(body, "external_name") ?? null,
      type,
      item_family_id: familyId,
      metered: readBoolean(body, "metered") ?? false,
      created: at,
      updated: at,
    });
    return c.json({ item: formatItem(item) });
  });

  app.get("/api/v2/items/:id", (c) => {
    const item = cs.items.findOneBy("chargebee_id", c.req.param("id"));
    if (!item) return notFound(c);
    return c.json({ item: formatItem(item) });
  });

  app.get("/api/v2/items", (c) => {
    const filters = readFilters(c, ["id", "type", "item_family_id"]);
    const rows = cs.items
      .all()
      .filter((item) => matchesFilters(filters, (field) => (field === "id" ? item.chargebee_id : fieldOf(item, field))))
      .sort((left, right) => left.created - right.created);
    return chargebeeList(c, rows, (item) => ({ item: formatItem(item) }));
  });

  // -- Item prices -------------------------------------------------------

  app.post("/api/v2/item_prices", async (c) => {
    const body = await parseChargebeeBody(c);
    const id = readString(body, "id");
    const itemId = readString(body, "item_id");

    if (!id) throw missingParam("id");
    if (!itemId) throw missingParam("item_id");

    if (cs.itemPrices.findOneBy("chargebee_id", id)) {
      return duplicate(c, `Item price [${id}] already exists`);
    }

    const item = cs.items.findOneBy("chargebee_id", itemId);
    if (!item) return notFound(c, `Item [${itemId}] not found`);

    const rawPricingModel = readString(body, "pricing_model") ?? "per_unit";
    const pricingModel = asPricingModel(rawPricingModel);
    if (!pricingModel) {
      // Tiered, volume and stairstep pricing are refused rather than approximated:
      // the bracket arithmetic is not publicly specified and a wrong total here would
      // surface as a passing test over a bad invoice.
      return notEmulated(
        c,
        `pricing_model=${rawPricingModel}`,
        "only per_unit and flat_fee are emulated; tiered and volume pricing arithmetic is not reproduced",
      );
    }

    const rawPeriodUnit = readString(body, "period_unit") ?? "month";
    const periodUnit = asPeriodUnit(rawPeriodUnit);
    if (!periodUnit) throw badParam("period_unit", `Unknown period unit: ${rawPeriodUnit}`);

    // A non-positive period would leave next_billing_at permanently due, so a single
    // time jump would generate invoices until the loop guard tripped.
    const period = readNumber(body, "period") ?? 1;
    if (!Number.isInteger(period) || period <= 0) {
      throw badParam("period", `period must be a positive integer, received ${period}`);
    }

    const price = readNumber(body, "price") ?? 0;
    if (price < 0) throw badParam("price", `price may not be negative, received ${price}`);

    const freeQuantity = readNumber(body, "free_quantity") ?? 0;
    if (freeQuantity < 0) {
      throw badParam("free_quantity", `free_quantity may not be negative, received ${freeQuantity}`);
    }

    const trialPeriod = readNumber(body, "trial_period");
    if (trialPeriod !== undefined && (!Number.isInteger(trialPeriod) || trialPeriod < 0)) {
      throw badParam("trial_period", `trial_period must be a non-negative integer, received ${trialPeriod}`);
    }

    const rawTrialPeriodUnit = readString(body, "trial_period_unit");
    const trialPeriodUnit = asPeriodUnit(rawTrialPeriodUnit);
    if (rawTrialPeriodUnit !== undefined && !trialPeriodUnit) {
      throw badParam("trial_period_unit", `Unknown trial period unit: ${rawTrialPeriodUnit}`);
    }

    const at = now(cs);
    const created = cs.itemPrices.insert({
      chargebee_id: id,
      name: readString(body, "name") ?? id,
      external_name: readString(body, "external_name") ?? null,
      item_family_id: item.item_family_id,
      item_id: item.chargebee_id,
      item_type: item.type,
      pricing_model: pricingModel,
      price,
      period,
      period_unit: periodUnit,
      free_quantity: freeQuantity,
      currency_code: readString(body, "currency_code") ?? "USD",
      trial_period: trialPeriod ?? null,
      trial_period_unit: trialPeriodUnit ?? null,
      created: at,
      updated: at,
    });

    return c.json({ item_price: formatItemPrice(created) });
  });

  app.get("/api/v2/item_prices/:id", (c) => {
    const price = cs.itemPrices.findOneBy("chargebee_id", c.req.param("id"));
    if (!price) return notFound(c);
    return c.json({ item_price: formatItemPrice(price) });
  });

  app.get("/api/v2/item_prices", (c) => {
    const filters = readFilters(c, ["id", "item_id", "item_type", "currency_code"]);
    const rows = cs.itemPrices
      .all()
      .filter((price) =>
        matchesFilters(filters, (field) => (field === "id" ? price.chargebee_id : fieldOf(price, field))),
      )
      .sort((left, right) => left.created - right.created);
    return chargebeeList(c, rows, (price) => ({ item_price: formatItemPrice(price) }));
  });
}
