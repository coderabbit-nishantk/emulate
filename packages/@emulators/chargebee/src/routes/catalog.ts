import type { RouteContext } from "@emulators/core";
import type { ItemType, PeriodUnit, PricingModel } from "../entities.js";
import { formatItem, formatItemFamily, formatItemPrice } from "../formatters.js";
import {
  chargebeeError,
  chargebeeList,
  fieldOf,
  matchesFilters,
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

const ITEM_TYPES: readonly string[] = ["plan", "addon", "charge"];
const PERIOD_UNITS: readonly string[] = ["day", "week", "month", "year"];
const PRICING_MODELS: readonly string[] = ["per_unit", "flat_fee"];

export function catalogRoutes({ app, store }: RouteContext): void {
  const cs = getChargebeeStore(store);

  // -- Item families ------------------------------------------------------

  app.post("/api/v2/item_families", async (c) => {
    const body = await parseChargebeeBody(c);
    const id = readString(body, "id");
    if (!id) return chargebeeError(c, 400, "param_required", "id is required", "invalid_request", "id");

    const existing = cs.itemFamilies.findOneBy("chargebee_id", id);
    if (existing) return chargebeeError(c, 409, "duplicate_entry", `Item family [${id}] already exists`);

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
    const type = readString(body, "type");

    if (!id || !familyId || !type) {
      return chargebeeError(c, 400, "param_required", "id, item_family_id and type are required");
    }
    if (!ITEM_TYPES.includes(type)) {
      return chargebeeError(c, 400, "param_wrong_value", `Unknown item type: ${type}`, "invalid_request", "type");
    }
    if (!cs.itemFamilies.findOneBy("chargebee_id", familyId)) {
      return notFound(c, `Item family [${familyId}] not found`);
    }

    const at = now(cs);
    const item = cs.items.insert({
      chargebee_id: id,
      name: readString(body, "name") ?? id,
      external_name: readString(body, "external_name") ?? null,
      type: type as ItemType,
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

    if (!id || !itemId) {
      return chargebeeError(c, 400, "param_required", "id and item_id are required");
    }

    const item = cs.items.findOneBy("chargebee_id", itemId);
    if (!item) return notFound(c, `Item [${itemId}] not found`);

    const pricingModel = readString(body, "pricing_model") ?? "per_unit";
    if (!PRICING_MODELS.includes(pricingModel)) {
      // Tiered, volume and stairstep pricing are refused rather than approximated:
      // the bracket arithmetic is not publicly specified and a wrong total here would
      // surface as a passing test over a bad invoice.
      return notEmulated(
        c,
        `pricing_model=${pricingModel}`,
        "only per_unit and flat_fee are emulated; tiered and volume pricing arithmetic is not reproduced",
      );
    }

    const periodUnit = readString(body, "period_unit") ?? "month";
    if (!PERIOD_UNITS.includes(periodUnit)) {
      return chargebeeError(
        c,
        400,
        "param_wrong_value",
        `Unknown period unit: ${periodUnit}`,
        "invalid_request",
        "period_unit",
      );
    }

    const trialPeriodUnit = readString(body, "trial_period_unit");
    const at = now(cs);
    const price = cs.itemPrices.insert({
      chargebee_id: id,
      name: readString(body, "name") ?? id,
      external_name: readString(body, "external_name") ?? null,
      item_family_id: item.item_family_id,
      item_id: itemId,
      item_type: item.type,
      pricing_model: pricingModel as PricingModel,
      price: readNumber(body, "price") ?? 0,
      period: readNumber(body, "period") ?? 1,
      period_unit: periodUnit as PeriodUnit,
      free_quantity: readNumber(body, "free_quantity") ?? 0,
      currency_code: readString(body, "currency_code") ?? "USD",
      trial_period: readNumber(body, "trial_period") ?? null,
      trial_period_unit:
        trialPeriodUnit && PERIOD_UNITS.includes(trialPeriodUnit) ? (trialPeriodUnit as PeriodUnit) : null,
      created: at,
      updated: at,
    });

    return c.json({ item_price: formatItemPrice(price) });
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
