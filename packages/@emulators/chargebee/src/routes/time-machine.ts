import type { RouteContext } from "@emulators/core";
import { billingErrorResponse, runDueWork } from "../billing.js";
import { chargebeeError, invalidState, now, parseChargebeeBody, readNumber, setNow } from "../helpers.js";
import { getChargebeeStore } from "../store.js";

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
 */
export function timeMachineRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getChargebeeStore(store);
  const ctx = { cs, webhooks };

  app.get("/api/v2/time_machines/:name", (c) => c.json(timeMachine(c.req.param("name"), now(cs))));

  app.post("/api/v2/time_machines/:name/travel_forward", async (c) => {
    const body = await parseChargebeeBody(c);
    const destination = readNumber(body, "destination_time");

    if (destination === undefined) {
      return chargebeeError(
        c,
        400,
        "param_required",
        "destination_time is required",
        "invalid_request",
        "destination_time",
      );
    }
    if (destination < now(cs)) {
      return invalidState(c, "A time machine can only travel forward");
    }

    setNow(cs, destination);
    try {
      await runDueWork(ctx);
    } catch (error) {
      const response = billingErrorResponse(c, error);
      if (response) return response;
      throw error;
    }

    return c.json(timeMachine(c.req.param("name"), now(cs)));
  });
}
