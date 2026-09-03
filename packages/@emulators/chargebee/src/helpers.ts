import { randomBytes } from "crypto";
import type { Context, ContentfulStatusCode } from "@emulators/core";
import type { PeriodUnit } from "./entities.js";
import type { ChargebeeStore } from "./store.js";

export type ErrorType = "payment" | "invalid_request" | "operation_failed" | "io_error" | "client_error";

export function chargebeeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url").slice(0, 16)}`;
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
// password. Any key is accepted, but a missing one still fails, so a misconfigured
// client breaks here the same way it would in production.
// ---------------------------------------------------------------------------

export function decodeBasicAuth(c: Context): { username: string; password: string } | null {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return { username: decoded, password: "" };
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function chargebeeError(
  c: Context,
  status: number,
  apiErrorCode: string,
  message: string,
  type: ErrorType = "invalid_request",
  param?: string,
) {
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
    status as ContentfulStatusCode,
  );
}

export function notFound(c: Context, detail?: string) {
  return chargebeeError(c, 404, "resource_not_found", detail ?? "Sorry, we couldn't find that resource");
}

export function invalidState(c: Context, message: string) {
  return chargebeeError(c, 409, "invalid_state_for_request", message);
}

export function paramError(c: Context, param: string, message: string) {
  return chargebeeError(c, 400, "param_wrong_value", message, "invalid_request", param);
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
export function notEmulated(c: Context, operation: string, reason: string) {
  return chargebeeError(
    c,
    501,
    "not_emulated",
    `${operation} is not emulated: ${reason}. See the chargebee emulator docs for what is covered.`,
    "operation_failed",
  );
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

export async function parseChargebeeBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const raw = await c.req.text();
  if (!raw) return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return parseBracketParams(new URLSearchParams(raw));
}

export function parseBracketParams(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const path = key.replace(/\]/g, "").split("[");
    let target: Record<string, unknown> = result;
    for (let i = 0; i < path.length - 1; i++) {
      const part = path[i] as string;
      const current = target[part];
      if (current === undefined || current === null || typeof current !== "object") {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[path[path.length - 1] as string] = value;
  }
  return result;
}

/**
 * Read a named field off an entity for filtering.
 *
 * Filters arrive as strings, so the field being read is only known at runtime. This
 * keeps that one unavoidable widening in a single place instead of scattering casts
 * through every list route.
 */
export function fieldOf(entity: object, name: string): unknown {
  return (entity as unknown as Record<string, unknown>)[name];
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
  return Number.isFinite(value) ? value : undefined;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}

export function readGroup(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
    if (!attribute || typeof attribute !== "object") continue;
    for (const index of Object.keys(attribute as Record<string, unknown>)) {
      const parsed = Number(index);
      if (Number.isInteger(parsed) && parsed >= 0) indices.add(parsed);
    }
  }

  const rows: Array<Record<string, string>> = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const row: Record<string, string> = {};
    for (const [attribute, values] of Object.entries(group)) {
      if (!values || typeof values !== "object") continue;
      const value = (values as Record<string, unknown>)[String(index)];
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
    if (node && typeof node === "object") {
      for (const [operator, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === "string") filters.push({ field, operator, value });
      }
    }
  }
  return filters;
}

function asList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [trimmed];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
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
        return true;
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
    return paramError(c, "offset", "Invalid offset");
  }

  const page = items.slice(start, start + limit);
  const end = start + page.length;

  return c.json({
    list: page.map(entries),
    ...(end < items.length ? { next_offset: String(end) } : {}),
  });
}
