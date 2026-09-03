# @emulators/chargebee

Chargebee Billing API v2 emulation with customers, a product catalog, subscription lifecycle, invoicing, payment sources, events and a time machine. Includes webhook delivery and an inspector.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/chargebee
```

## Pointing the Chargebee SDK at the emulator

The SDK builds its base URL from configuration, so three fields are the whole change. Nothing in your application code moves.

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

Chargebee authenticates with HTTP basic, the API key as the username and an empty password. Any non-empty key is accepted; a missing or empty one is rejected, including a header such as `Basic Og==` that decodes to no username, so a misconfigured client fails here the way it would in production.

## Time is an input, not a fact

Nothing in the emulator reads the wall clock. A subscription renews because a caller moved time forward, and when they do, every transition that was due actually happens: twelve renewals for a year, in order, each with its invoice and its event.

```bash
curl -u any: -X POST localhost:4000/api/v2/time_machines/default/travel_forward \
  -d destination_time=1798761600
```

Chargebee's own time machine queues the jump and rate limits polling. This one returns the same shape but completes instantly, so polling code still works and simply finishes on its first read.

The clock starts at `2026-01-01T00:00:00Z` and can be set with the `now` seed key.

## Endpoints

### Customers

- `POST /api/v2/customers` — create customer
- `GET /api/v2/customers/:id` — retrieve customer
- `POST /api/v2/customers/:id` — update customer
- `POST /api/v2/customers/:id/update_billing_info` — update billing info
- `GET /api/v2/customers` — list customers

### Catalog

- `POST /api/v2/item_families`, `GET /api/v2/item_families/:id`, `GET /api/v2/item_families`
- `POST /api/v2/items`, `GET /api/v2/items/:id`, `GET /api/v2/items`
- `POST /api/v2/item_prices`, `GET /api/v2/item_prices/:id`, `GET /api/v2/item_prices`

### Subscriptions

- `POST /api/v2/customers/:id/subscription_for_items` — create subscription
- `GET /api/v2/subscriptions/:id` — retrieve subscription
- `GET /api/v2/subscriptions` — list subscriptions
- `POST /api/v2/subscriptions/:id/update_for_items` — change items (unprorated only)
- `POST /api/v2/subscriptions/:id/cancel_for_items` — cancel, immediately or at term end
- `POST /api/v2/subscriptions/:id/reactivate` — reactivate
- `POST /api/v2/subscriptions/:id/change_term_end` — move the term boundary

### Invoices

- `GET /api/v2/invoices/:id` — retrieve invoice
- `GET /api/v2/invoices` — list invoices

### Payment sources

- `POST /api/v2/payment_sources/create_card` — add a card
- `GET /api/v2/payment_sources/:id`, `GET /api/v2/payment_sources`
- `POST /api/v2/payment_sources/:id/delete` — remove a card

### Hand-off surfaces

- `POST /api/v2/portal_sessions` — create portal session
- `POST /api/v2/hosted_pages/collect_now`, `checkout_new_for_items`, `manage_payment_sources`
- `GET /portal/:id`, `GET /hosted/:id` — placeholder hand-off pages (HTML)

### Events and time

- `GET /api/v2/events/:id`, `GET /api/v2/events`
- `GET /api/v2/time_machines/:name` — read the clock
- `POST /api/v2/time_machines/:name/travel_forward` — advance the clock and run due work

### Inspector

- `GET /` — customers, subscriptions, invoices, catalog, events, and a coverage table

## Webhooks

Chargebee authenticates webhook deliveries with HTTP basic credentials configured on the receiving endpoint. It sends no HMAC signature, so none is invented here: signing would let an application be tested against a header production never sends.

A configured secret of `user:pass` becomes those basic credentials; a bare value is used as the username with an empty password.

Events emitted: `customer_created`, `customer_changed`, `payment_source_added`, `payment_source_deleted`, `subscription_created`, `subscription_activated`, `subscription_renewed`, `subscription_changed`, `subscription_cancellation_scheduled`, `subscription_cancelled`, `subscription_reactivated`, `invoice_generated`.

## Seed config

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

Prices are in the currency's minor unit. `with_card: true` attaches a valid card so invoices settle rather than sit payable.

## What is and is not reproduced

Billing is mostly arithmetic, and some of the arithmetic Chargebee applies is not published. The `Coverage` tab in the inspector is the authoritative answer; in summary:

**Exact** — customers, catalog, payment sources, subscription lifecycle including calendar-aware term arithmetic (a term anchored on 31 January advances to 28 February), unprorated item changes, list filters and opaque-offset pagination, error payloads, the event log.

**Approximated** — invoices carry no tax and settle instantly when a valid card exists, so no gateway latency or decline is modelled; cards are never declined; portal sessions and hosted pages return correctly shaped objects whose URLs resolve to a placeholder rather than a Chargebee UI; the time machine is instant rather than queued.

**Refused with `501 not_emulated`** — proration, tax, dunning, estimates, coupons and discounts, credit notes, refunds, metered usage, tiered pricing.

That last group is deliberate. Those behaviors depend on undocumented arithmetic, and a plausible wrong number is worse than an error: it turns into a passing test over figures production computes differently. The `not_emulated` code is one the real API never sends, so a scenario that strays into unsupported territory fails visibly. Anything whose truth depends on those numbers has to run against a real Chargebee site.
