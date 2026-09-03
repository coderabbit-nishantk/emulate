import type { Server } from "node:http";
import Chargebee from "chargebee";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@emulators/core";
import { DEFAULT_EPOCH } from "../index.js";
import { catalogSeed, createChargebeeTestApp } from "./helpers.js";

/**
 * The acceptance test for the whole approach.
 *
 * Everything here goes through the real `chargebee` npm package with no patching, no
 * interception and no injected transport. The only difference from production is
 * three configuration fields the SDK already supports, which is what makes it
 * possible to point an application at the emulator without touching its source.
 */

let server: Server;
let chargebee: InstanceType<typeof Chargebee>;

beforeEach(async () => {
  const { app } = createChargebeeTestApp(catalogSeed());
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  chargebee = new Chargebee({
    site: "127.0.0.1",
    apiKey: "any_key_is_accepted",
    protocol: "http",
    hostSuffix: "",
    port,
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("unmodified chargebee SDK", () => {
  it("drives a full customer-to-renewal flow", async () => {
    const { customer } = await chargebee.customer.create({
      id: "cus_sdk",
      email: "sdk@acme.example",
      company: "Acme",
    });
    expect(customer.id).toBe("cus_sdk");
    expect(customer.object).toBe("customer");

    await chargebee.paymentSource.createCard({
      customer_id: "cus_sdk",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2031, cvv: "123" },
    });

    const created = await chargebee.subscription.createWithItems("cus_sdk", {
      subscription_items: [{ item_price_id: "pro-monthly", quantity: 3 }],
    });
    expect(created.subscription.status).toBe("active");
    // Proves the indexed multi-value encoding survived the round trip.
    expect(created.subscription.subscription_items).toHaveLength(1);
    expect(created.subscription.subscription_items?.[0]).toMatchObject({
      item_price_id: "pro-monthly",
      quantity: 3,
    });
    expect(created.invoice?.total).toBe(9000);
    expect(created.invoice?.status).toBe("paid");

    const id = created.subscription.id;
    const retrieved = await chargebee.subscription.retrieve(id);
    expect(retrieved.subscription.id).toBe(id);
    expect(retrieved.customer?.id).toBe("cus_sdk");

    await chargebee.timeMachine.travelForward("default", { destination_time: DEFAULT_EPOCH + 200 * 86400 });

    const invoices = await chargebee.invoice.list({ limit: 100 });
    // Six monthly renewals plus the first invoice.
    expect(invoices.list.length).toBeGreaterThan(5);
    expect(invoices.list.every((entry) => entry.invoice.currency_code === "USD")).toBe(true);

    const renewed = await chargebee.subscription.retrieve(id);
    expect(renewed.subscription.status).toBe("active");
    expect(renewed.subscription.current_term_start).toBeGreaterThan(DEFAULT_EPOCH);
  });

  it("surfaces emulator errors as ordinary SDK errors", async () => {
    await expect(chargebee.customer.retrieve("missing")).rejects.toMatchObject({
      api_error_code: "resource_not_found",
      http_status_code: 404,
      type: "invalid_request",
    });
  });

  it("reports a refused operation distinguishably", async () => {
    const created = await chargebee.subscription.createWithItems("cus_acme", {
      subscription_items: [{ item_price_id: "pro-monthly" }],
    });

    await expect(
      chargebee.subscription.updateForItems(created.subscription.id, {
        subscription_items: [{ item_price_id: "pro-monthly", quantity: 9 }],
        prorate: true,
      }),
    ).rejects.toMatchObject({
      api_error_code: "not_emulated",
      http_status_code: 501,
    });
  });

  it("cancels and reactivates through the SDK", async () => {
    const created = await chargebee.subscription.createWithItems("cus_acme", {
      subscription_items: [{ item_price_id: "pro-monthly" }],
    });

    const cancelled = await chargebee.subscription.cancelForItems(created.subscription.id, { end_of_term: false });
    expect(cancelled.subscription.status).toBe("cancelled");

    const reactivated = await chargebee.subscription.reactivate(created.subscription.id);
    expect(reactivated.subscription.status).toBe("active");
  });

  it("paginates through the SDK list helpers", async () => {
    for (let index = 0; index < 6; index += 1) {
      await chargebee.customer.create({ id: `cus_page_${index}` });
    }

    const first = await chargebee.customer.list({ limit: 3 });
    expect(first.list).toHaveLength(3);
    expect(first.next_offset).toBeDefined();

    const second = await chargebee.customer.list({ limit: 3, offset: first.next_offset });
    expect(second.list.length).toBeGreaterThan(0);
    expect(second.list[0]?.customer.id).not.toBe(first.list[0]?.customer.id);
  });
});
