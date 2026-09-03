---
name: chargebee
description: Emulated Chargebee Billing API for local development and testing. Use when the user needs to test subscription billing locally, create customers and subscriptions, generate invoices, exercise renewals and trials, travel forward in time to trigger billing events, handle Chargebee webhooks, or use the Chargebee SDK without hitting real Chargebee servers. Triggers include "Chargebee API", "emulate Chargebee", "test billing locally", "subscription renewal", "trial expiry", "invoice generation", "Chargebee webhook", "Chargebee SDK", "CHARGEBEE_SITE", "CHARGEBEE_API_KEY", or any task requiring a local Chargebee API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Chargebee API Emulator

Stateful Chargebee Billing API v2 emulation. Customers, item families, items, item prices, subscriptions, invoices, payment sources and events persist in memory. Webhooks fire on state changes.

The clock is an input rather than a fact, so a year of renewals can be exercised in a millisecond and the result is the same every run.

No real charges are made. Every Chargebee SDK call hits the emulator.

## Start

```bash
# Chargebee only
npx emulate --service chargebee

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const chargebee = await createEmulator({ service: "chargebee", port: 4000 });
// chargebee.url === 'http://localhost:4000'
```

## Pointing Your App at the Emulator

### Chargebee SDK

The SDK builds its base URL from configuration, so three fields are the whole change:

```typescript
import Chargebee from "chargebee";

const chargebee = new Chargebee({
  site: "127.0.0.1",
  apiKey: "any_key_is_accepted",
  protocol: "http", // default: https
  hostSuffix: "", // default: .chargebee.com
  port: 4000,
});
```

Authentication is HTTP basic with the API key as the username and an empty password. Any non-empty key is accepted; a missing or empty one is rejected, including a header such as `Basic Og==` that decodes to no username, so a misconfigured client fails the way it would in production.

### curl

```bash
curl -u any: http://localhost:4000/api/v2/customers
```

## Core Flow

```typescript
// Catalog
await chargebee.itemFamily.create({ id: "acme", name: "Acme" });
await chargebee.item.create({ id: "pro", name: "Pro", type: "plan", item_family_id: "acme" });
await chargebee.itemPrice.create({
  id: "pro-monthly",
  item_id: "pro",
  price: 3000, // minor units
  period: 1,
  period_unit: "month",
  currency_code: "USD",
});

// Customer with a card, so invoices settle instead of sitting payable
await chargebee.customer.create({ id: "cus_acme", email: "billing@acme.example" });
await chargebee.paymentSource.createCard({
  customer_id: "cus_acme",
  card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2031, cvv: "123" },
});

// Subscription, which issues a first invoice immediately
const { subscription, invoice } = await chargebee.subscription.createWithItems("cus_acme", {
  subscription_items: [{ item_price_id: "pro-monthly", quantity: 3 }],
});
```

## Time Travel

Advancing the clock runs every transition it makes due, in order, each with its invoice and its event. This is how to test renewals, trial expiry and end-of-term cancellation.

```typescript
// Jump forward one year: twelve renewals, twelve invoices, twelve events
await chargebee.timeMachine.travelForward("default", { destination_time: 1798761600 });

const invoices = await chargebee.invoice.list({ limit: 100 });
```

```bash
curl -u any: -X POST localhost:4000/api/v2/time_machines/default/travel_forward \
  -d destination_time=1798761600
```

Read the clock without moving it:

```bash
curl -u any: localhost:4000/api/v2/time_machines/default
```

The clock only moves forward. Travelling backwards returns `invalid_state_for_request`. It starts at `2026-01-01T00:00:00Z` unless the seed sets `now`.

## Seed Config

```yaml
chargebee:
  now: 2026-01-01T00:00:00Z
  item_families:
    - id: acme
      name: Acme
  items:
    - id: pro
      name: Pro
      type: plan
      item_family: acme
  item_prices:
    - id: pro-monthly
      item: pro
      name: Pro Monthly
      price: 3000
      period: 1
      period_unit: month
    - id: pro-trial
      item: pro
      name: Pro with trial
      price: 3000
      trial_period: 14
      trial_period_unit: day
  customers:
    - id: cbdemo_acme
      email: billing@acme.example
      company: Acme
      with_card: true
  subscriptions:
    - customer: cbdemo_acme
      item_price: pro-monthly
      quantity: 1
  webhooks:
    - url: http://localhost:3000/api/webhooks/chargebee
      events: ["*"]
      secret: hookuser:hookpass
```

Seeded state is a precondition rather than something that happened, so seeding fires no webhooks.

## Webhooks

Chargebee authenticates deliveries with HTTP basic credentials on the receiving endpoint and sends no HMAC signature, so the emulator sends none either. A secret of `user:pass` becomes those credentials; a bare value is the username with an empty password.

Events: `customer_created`, `customer_changed`, `payment_source_added`, `payment_source_deleted`, `subscription_created`, `subscription_activated`, `subscription_renewed`, `subscription_changed`, `subscription_cancellation_scheduled`, `subscription_cancelled`, `subscription_reactivated`, `invoice_generated`.

## Inspector

`GET /` serves tabs for customers, subscriptions, invoices, catalog and events, plus a `Coverage` tab stating exactly what is reproduced and what is refused.

## What Is Not Emulated

These return `501` with `api_error_code: not_emulated`, a code the real API never sends:

- proration (`prorate=true` on an item change)
- tax
- dunning and payment retries
- estimates
- coupons and discounts
- credit notes and refunds
- metered usage
- tiered, volume and stairstep pricing

This is deliberate. Those behaviors depend on arithmetic Chargebee does not publish, and a plausible wrong number is worse than an error: it becomes a passing test over figures production computes differently. If a task needs any of them, say so and run it against a real Chargebee test site rather than trusting a local result.

Also approximated, and worth knowing before reading too much into a result: invoices carry no tax and settle instantly when a valid card exists, cards are never declined, and portal sessions and hosted pages return correctly shaped objects whose URLs resolve to a placeholder rather than a Chargebee UI.
