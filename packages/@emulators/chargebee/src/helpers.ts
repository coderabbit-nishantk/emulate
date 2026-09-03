import { randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import type { ItemType, PeriodUnit, PricingModel } from "./entities.js";
import type { ChargebeeStore } from "./store.js";

export type ErrorType = "payment" | "invalid_request" | "operation_failed" | "io_error" | "client_error";

export function chargebeeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Errors
//
// Request handling raises RequestError from wherever the problem is noticed, and
// one middleware turns it into a Chargebee-shaped response. Keeping that in a
// single place means a new validation rule cannot forget to produce the right
// error body, and route handlers stay readable.
// ---------------------------------------------------------------------------

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiErrorCode: string,
    message: string,
    readonly errorType: ErrorType = "invalid_request",
    readonly param?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function chargebeeError(
  c: Context,
  status: number,
  apiErrorCode: string,
  message: string,
  type: ErrorType = "invalid_request",
  param?: string,
): Response {
  return c.json(
    {
      message,
      type,
      api_error_code: apiErrorCode,
      error_code: apiErrorCode,
      error_msg: message,
      http_status_code: status,
      ...(param ? { param, error_param: param } : {}),
    },
    status,
  );
}

/** Render a RequestError, or return null when the failure is something else. */
export function requestErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof RequestError)) return null;
  return chargebeeError(c, error.status, error.apiErrorCode, error.message, error.errorType, error.param);
}

export function notFound(c: Context, detail?: string): Response {
  return chargebeeError(c, 404, "resource_not_found", detail ?? "Sorry, we couldn't find that resource");
}

export function invalidState(c: Context, message: string): Response {
  return chargebeeError(c, 409, "invalid_state_for_request", message);
}

export function duplicate(c: Context, message: string): Response {
  return chargebeeError(c, 409, "duplicate_entry", message);
}

export function missingParam(param: string, message?: string): RequestError {
  return new RequestError(400, "param_required", message ?? `${param} is required`, "invalid_request", param);
}

export function badParam(param: string, message: string): RequestError {
  return new RequestError(400, "param_wrong_value", message, "invalid_request", param);
}

/**
 * Refuse an operation this emulator does not reproduce faithfully.
 *
 * The status and code are deliberately outside Chargebee's own vocabulary. Behavior
 * that depends on undocumented arithmetic — proration, tax, dunning schedules — is
 * refused rather than guessed, because a plausible wrong number turns into a passing
 * test over figures production computes differently. Failing loudly is recoverable;
 * silently disagreeing with the real API is not.
 */
export function notEmulated(c: Context, operation: string, reason: string): Response {
  return chargebeeError(
    c,
    501,
    "not_emulated",
    `${operation} is not emulated: ${reason}. See the chargebee emulator docs for what is covered.`,
    "operation_failed",
  );
}

// ---------------------------------------------------------------------------
// Clock
//
// Chargebee bills on term boundaries, so almost every interesting behavior is a
// function of time. The emulator therefore treats time as an input: it never reads
// the wall clock, and a scenario that wants a renewal asks for one.
// ---------------------------------------------------------------------------

/** 2026-01-01T00:00:00Z. A fixed epoch keeps an unseeded run reproducible. */
export const DEFAULT_EPOCH = 1767225600;

function metaRow(cs: ChargebeeStore) {
  const existing = cs.meta.all()[0];
  if (existing) return existing;
  return cs.meta.insert({ now: DEFAULT_EPOCH, invoice_seq: 0 });
}

export function now(cs: ChargebeeStore): number {
  return metaRow(cs).now;
}

export function setNow(cs: ChargebeeStore, seconds: number): void {
  const row = metaRow(cs);
  cs.meta.update(row.id, { now: Math.floor(seconds) });
}

export function nextInvoiceNumber(cs: ChargebeeStore): string {
  const row = metaRow(cs);
  const next = row.invoice_seq + 1;
  cs.meta.update(row.id, { invoice_seq: next });
  return String(next);
}

// ---------------------------------------------------------------------------
// Period arithmetic
// ---------------------------------------------------------------------------

const FIXED_PERIOD_SECONDS: Record<"day" | "week", number> = {
  day: 86400,
  week: 604800,
};

/**
 * Advance a unix-second timestamp by a billing period.
 *
 * Month and year steps are calendar aware and clamp to the end of shorter months,
 * so a term anchored on 31 January advances to 28 February. Chargebee behaves this
 * way, and approximating a month as thirty days is the most common source of
 * off-by-one-day billing bugs, so it is reproduced exactly.
 */
export function addPeriod(fromSeconds: number, period: number, unit: PeriodUnit): number {
  if (period <= 0) {
    throw new RequestError(
      500,
      "internal_error",
      `A billing period must be positive, received ${period}`,
      "operation_failed",
    );
  }

  if (unit === "day" || unit === "week") {
    return fromSeconds + period * FIXED_PERIOD_SECONDS[unit];
  }

  const source = new Date(fromSeconds * 1000);
  const anchorDay = source.getUTCDate();
  const target = new Date(source.getTime());
  target.setUTCDate(1);
  if (unit === "month") {
    target.setUTCMonth(target.getUTCMonth() + period);
  } else {
    target.setUTCFullYear(target.getUTCFullYear() + period);
  }
  const daysInTargetMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, daysInTargetMonth));
  return Math.floor(target.getTime() / 1000);
}

export function monthsInPeriod(period: number, unit: PeriodUnit): number {
  if (unit === "year") return period * 12;
  if (unit === "month") return period;
  if (unit === "week") return (period * 7) / 30;
  return period / 30;
}

// ---------------------------------------------------------------------------
// Authentication
//
// Chargebee authenticates with HTTP basic, the API key as the username and an empty
// password. Any key is accepted, but the username has to be there: checking only
// for the scheme prefix would let `Authorization: Basic Og==`, which decodes to an
// empty username, authenticate as though a key had been supplied.
// ---------------------------------------------------------------------------

export function decodeBasicAuth(c: Context): { username: string; password: string } | null {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return null;

  const encoded = header.slice(6).trim();
  if (!encoded) return null;

  // Buffer.from does not throw on malformed base64, it discards what it cannot
  // decode, so there is nothing here to catch.
  const decoded = Buffer.from(encoded, "base64").toString("utf8");

  const separator = decoded.indexOf(":");
  if (separator === -1) return { username: decoded, password: "" };
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// Type guards
//
// The repository bans `as` assertions, and for parsing untrusted request values
// that is the right rule: an assertion here would let a nonsense period unit or
// item type through to be stored and later formatted into a response.
// ---------------------------------------------------------------------------

const ITEM_TYPES: readonly ItemType[] = ["plan", "addon", "charge"];
const PERIOD_UNITS: readonly PeriodUnit[] = ["day", "week", "month", "year"];
const PRICING_MODELS: readonly PricingModel[] = ["per_unit", "flat_fee"];

export function asItemType(value: string | undefined): ItemType | undefined {
  return ITEM_TYPES.find((candidate) => candidate === value);
}

export function asPeriodUnit(value: string | undefined): PeriodUnit | undefined {
  return PERIOD_UNITS.find((candidate) => candidate === value);
}

export function asPricingModel(value: string | undefined): PricingModel | undefined {
  return PRICING_MODELS.find((candidate) => candidate === value);
}

/**
 * Chargebee pricing models this emulator does not reproduce.
 *
 * Kept separate from unrecognised values so the two get different errors. A real
 * model the emulator refuses is a 501; a typo is a 400, which is what the real API
 * returns. Answering "not emulated" to `per_unt` would send someone hunting for a
 * missing feature instead of a misspelling.
 */
const UNSUPPORTED_PRICING_MODELS: readonly string[] = ["tiered", "volume", "stairstep"];

export type PricingModelSupport = "supported" | "unsupported" | "unknown";

export function classifyPricingModel(value: string): PricingModelSupport {
  if (asPricingModel(value)) return "supported";
  if (UNSUPPORTED_PRICING_MODELS.includes(value)) return "unsupported";
  return "unknown";
}

/**
 * Validate an enum value coming from seed configuration.
 *
 * Seeding used to fall back to a default when it could not recognise a value, so a
 * seed saying `period_unit: fortnight` produced monthly billing with no signal,
 * while the same value over HTTP was rejected. A seed file is a precondition the
 * whole run depends on, so a typo in one should stop startup rather than quietly
 * change what is being tested.
 */
export function seedEnum<T>(normalized: T | undefined, raw: string | undefined, label: string): T | undefined {
  if (raw !== undefined && normalized === undefined) {
    throw new Error(`chargebee seed: ${label} has an unknown value (${raw})`);
  }
  return normalized;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a named field off an entity for filtering.
 *
 * Filters name their field as a string, so the read is only resolvable at runtime.
 * `Reflect.get` keeps that in one place without widening the entity types.
 */
export function fieldOf(entity: object, name: string): unknown {
  return Reflect.get(entity, name);
}

// ---------------------------------------------------------------------------
// Request parsing
//
// Chargebee accepts form-encoded parameters with a bracket notation that is
// multi-dimensional rather than nested-object shaped. A list of subscription items
// arrives as one indexed map per attribute:
//
//   subscription_items[item_price_id][0]=pro-monthly
//   subscription_items[quantity][0]=5
//
// Reassembling those into records is the most protocol-specific step here, and
// getting it wrong is the quickest way to look compatible while quietly dropping
// fields.
// ---------------------------------------------------------------------------

/**
 * Keys that must never be used as a path segment.
 *
 * Without this, `__proto__[x]=1` would walk the accumulator up to Object.prototype
 * and write there, so a single query string could change object behavior for the
 * whole process. Accumulators are also created with a null prototype, which removes
 * the inherited properties this walk could otherwise reach.
 */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export async function parseChargebeeBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const raw = await c.req.text();
  if (!raw) return Object.create(null);

  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badParam("body", "Request body is not valid JSON");
    }
    if (!isPlainObject(parsed)) return Object.create(null);
    return { ...Object.create(null), ...parsed };
  }

  return parseBracketParams(new URLSearchParams(raw));
}

export function parseBracketParams(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  for (const [key, value] of params) {
    const path = key.replace(/\]/g, "").split("[");

    const forbidden = path.find((segment) => FORBIDDEN_KEYS.includes(segment));
    if (forbidden !== undefined) {
      throw badParam(key, `Parameter name may not contain ${forbidden}`);
    }

    let target = result;
    for (let i = 0; i < path.length - 1; i++) {
      const part = path[i];
      if (part === undefined) continue;
      const current = target[part];
      if (!isPlainObject(current)) {
        target[part] = Object.create(null);
      }
      const next = target[part];
      if (!isPlainObject(next)) break;
      target = next;
    }

    const last = path[path.length - 1];
    if (last !== undefined) target[last] = value;
  }

  return result;
}

export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw badParam(key, `${key} must be a number, received ${raw}`);
  }
  return value;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}

export function readGroup(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isPlainObject(value) ? value : Object.create(null);
}

/**
 * Pivot Chargebee's per-attribute indexed maps into records.
 *
 * `{ item_price_id: { 0: "a", 1: "b" }, quantity: { 0: "1" } }` becomes
 * `[{ item_price_id: "a", quantity: "1" }, { item_price_id: "b" }]`.
 */
export function readIndexed(source: Record<string, unknown>, key: string): Array<Record<string, string>> {
  const group = readGroup(source, key);
  const indices = new Set<number>();

  for (const attribute of Object.values(group)) {
    if (!isPlainObject(attribute)) continue;
    for (const index of Object.keys(attribute)) {
      const parsed = Number(index);
      if (Number.isInteger(parsed) && parsed >= 0) indices.add(parsed);
    }
  }

  const rows: Array<Record<string, string>> = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const row: Record<string, string> = {};
    for (const [attribute, values] of Object.entries(group)) {
      if (!isPlainObject(values)) continue;
      const value = values[String(index)];
      if (typeof value === "string" && value !== "") row[attribute] = value;
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// List responses
// ---------------------------------------------------------------------------

export interface Filter {
  field: string;
  operator: string;
  value: string;
}

const FILTER_OPERATORS: readonly string[] = [
  "is",
  "is_not",
  "in",
  "not_in",
  "starts_with",
  "is_present",
  "gt",
  "gte",
  "lt",
  "lte",
];

/** Read Chargebee list filters such as `status[is]=active` or `id[in]=["a","b"]`. */
export function readFilters(c: Context, fields: readonly string[]): Filter[] {
  const parsed = parseBracketParams(new URLSearchParams(c.req.url.split("?")[1] ?? ""));
  const filters: Filter[] = [];

  for (const field of fields) {
    const node = parsed[field];
    if (node === undefined) continue;

    if (typeof node === "string") {
      filters.push({ field, operator: "is", value: node });
      continue;
    }

    if (!isPlainObject(node)) continue;
    for (const [operator, value] of Object.entries(node)) {
      if (typeof value !== "string") continue;
      // Rejected rather than ignored. Treating an unrecognised operator as a
      // no-op makes a filter silently match everything, so a typo'd query returns
      // the whole collection and the caller believes it was filtered.
      if (!FILTER_OPERATORS.includes(operator)) {
        throw badParam(`${field}[${operator}]`, `Unsupported filter operator: ${field}[${operator}]`);
      }
      filters.push({ field, operator, value });
    }
  }

  return filters;
}

function asList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [trimmed];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw badParam("filter", `Could not parse list filter value: ${value}`);
  }
  return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
}

export function matchesFilters(filters: readonly Filter[], read: (field: string) => unknown): boolean {
  return filters.every((filter) => {
    const actual = read(filter.field);
    const text = actual === undefined || actual === null ? "" : String(actual);
    switch (filter.operator) {
      case "is":
        return text === filter.value;
      case "is_not":
        return text !== filter.value;
      case "in":
        return asList(filter.value).includes(text);
      case "not_in":
        return !asList(filter.value).includes(text);
      case "starts_with":
        return text.startsWith(filter.value);
      case "is_present":
        return (filter.value === "true") === (text !== "");
      case "gt":
        return Number(text) > Number(filter.value);
      case "gte":
        return Number(text) >= Number(filter.value);
      case "lt":
        return Number(text) < Number(filter.value);
      case "lte":
        return Number(text) <= Number(filter.value);
      default:
        // readFilters rejects unknown operators, so reaching here means the two
        // lists have drifted apart.
        throw badParam(filter.field, `Unsupported filter operator: ${filter.field}[${filter.operator}]`);
    }
  });
}

/**
 * Chargebee list pagination. The offset is an opaque token rather than an index, and
 * it is only present when more rows remain.
 */
export function chargebeeList<T>(c: Context, items: readonly T[], entries: (item: T) => Record<string, unknown>) {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "10", 10) || 10, 1), 100);
  const rawOffset = c.req.query("offset");
  const start = rawOffset === undefined ? 0 : parseInt(rawOffset, 10);
  if (!Number.isInteger(start) || start < 0) {
    throw badParam("offset", "Invalid offset");
  }

  const page = items.slice(start, start + limit);
  const end = start + page.length;

  return c.json({
    list: page.map(entries),
    ...(end < items.length ? { next_offset: String(end) } : {}),
  });
}
