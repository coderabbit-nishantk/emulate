import type { AppEnv } from "@emulators/core";
import { Hono, Store, WebhookDispatcher, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import { chargebeePlugin, seedFromConfig, type ChargebeeSeedConfig } from "../index.js";

export const BASE = "http://localhost:14100";

/** Chargebee sends the API key as the basic-auth username with an empty password. */
export const AUTH = `Basic ${Buffer.from("cb_test_key:").toString("base64")}`;

export interface TestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export interface Result {
  status: number;
  // Responses are untyped JSON here on purpose: these tests assert on the wire
  // shape rather than on the emulator's internal types.
  body: any;
}

export function createChargebeeTestApp(seed?: ChargebeeSeedConfig): TestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();

  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  chargebeePlugin.register(app, store, webhooks, BASE);

  if (seed) {
    seedFromConfig(store, BASE, seed, webhooks);
  } else {
    chargebeePlugin.seed?.(store, BASE);
  }

  return { app, store, webhooks };
}

export function form(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function result(response: Response): Promise<Result> {
  return { status: response.status, body: await response.json() };
}

export async function post(
  app: Hono<AppEnv>,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<Result> {
  return result(
    await app.request(path, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" },
      body: form(params),
    }),
  );
}

/** POST with a raw body, for exercising encodings the form helper would escape. */
export async function postRaw(app: Hono<AppEnv>, path: string, body: string): Promise<Result> {
  return result(
    await app.request(path, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

export async function get(app: Hono<AppEnv>, path: string): Promise<Result> {
  return result(await app.request(path, { headers: { Authorization: AUTH } }));
}

/** A catalog with one monthly plan, and optionally a trial on it. */
export function catalogSeed(options: { trialDays?: number; price?: number } = {}): ChargebeeSeedConfig {
  return {
    item_families: [{ id: "acme", name: "Acme" }],
    items: [{ id: "pro", name: "Pro", type: "plan", item_family: "acme" }],
    item_prices: [
      {
        id: "pro-monthly",
        item: "pro",
        name: "Pro Monthly",
        price: options.price ?? 3000,
        period: 1,
        period_unit: "month",
        ...(options.trialDays ? { trial_period: options.trialDays, trial_period_unit: "day" as const } : {}),
      },
    ],
    customers: [{ id: "cus_acme", email: "billing@acme.example", company: "Acme", with_card: true }],
  };
}
