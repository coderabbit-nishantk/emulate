import type { RouteContext } from "@emulators/core";
import { countDueTerms, MAX_TERMS_PER_RUN, runDueWork } from "../billing.js";
import { badParam, invalidState, missingParam, now, parseChargebeeBody, readNumber, setNow } from "../helpers.js";
import { getChargebeeStore, restoreChargebee, snapshotChargebee } from "../store.js";

function timeMachine(name: string, destination: number): Record<string, unknown> {
  return {
    time_machine: {
      name,
      object: "time_machine",
      time_travel_status: "succeeded",
      destination_time: destination,
    },
  };
}

/**
 * Chargebee's own time machine queues the jump and rate limits polling, so callers
 * loop until it reports success. Here the jump is instantaneous and always succeeds.
 * The response shape is identical, so polling code still works and simply finishes
 * on its first read; the divergence is in the caller's favour and is the reason a
 * year of billing can be exercised in a millisecond.
 *
 * A jump is all-or-nothing. Two things make that true, and both are needed:
 *
 * Rejecting a jump too large to bill. Every term costs one iteration, so a daily
 * plan reaches the internal guard after roughly five and a half years and a monthly
 * plan after a hundred and sixty. Without this check a far-future destination would
 * advance the clock, write thousands of invoices, then fail — and a retry would
 * append the same batch again. The term count is computed first, so nothing is
 * written unless the whole jump can complete.
 *
 * Restoring on failure. The count is only as good as its agreement with the billing
 * loop, and other faults are possible mid-run, so the emulator's own collections are
 * snapshotted and put back if anything throws. Only Chargebee's collections are
 * captured: the core store is shared with every other service plugin on the server,
 * so restoring the whole store would roll back their state too.
 */
export function timeMachineRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getChargebeeStore(store);
  const ctx = { cs, webhooks };

  app.get("/api/v2/time_machines/:name", (c) => c.json(timeMachine(c.req.param("name"), now(cs))));

  app.post("/api/v2/time_machines/:name/travel_forward", async (c) => {
    const body = await parseChargebeeBody(c);
    const destination = readNumber(body, "destination_time");
    if (destination === undefined) throw missingParam("destination_time");

    if (destination < now(cs)) {
      return invalidState(c, "A time machine can only travel forward");
    }

    const terms = countDueTerms(cs, destination);
    if (terms > MAX_TERMS_PER_RUN) {
      throw badParam(
        "destination_time",
        `destination_time is too far ahead: it would bill ${terms} or more terms for a single subscription, above the limit of ${MAX_TERMS_PER_RUN}. Travel in smaller steps.`,
      );
    }

    const before = snapshotChargebee(cs);
    try {
      setNow(cs, destination);
      await runDueWork(ctx);
    } catch (error) {
      restoreChargebee(before);
      throw error;
    }

    return c.json(timeMachine(c.req.param("name"), now(cs)));
  });
}
