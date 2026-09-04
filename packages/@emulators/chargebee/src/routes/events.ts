import type { RouteContext } from "@emulators/core";
import { formatEvent } from "../formatters.js";
import { chargebeeList, fieldOf, matchesFilters, notFound, readFilters } from "../helpers.js";
import { getChargebeeStore } from "../store.js";

export function eventRoutes({ app, store }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.get("/api/v2/events/:id", (c) => {
    const event = cs.events.findOneBy("chargebee_id", c.req.param("id"));
    if (!event) return notFound(c);
    return c.json({ event: formatEvent(event) });
  });

  app.get("/api/v2/events", (c) => {
    const filters = readFilters(c, ["id", "event_type", "occurred_at"]);
    const rows = cs.events
      .all()
      .filter((event) =>
        matchesFilters(filters, (field) => (field === "id" ? event.chargebee_id : fieldOf(event, field))),
      )
      .sort((left, right) => left.occurred_at - right.occurred_at || left.id - right.id);

    return chargebeeList(c, rows, (event) => ({ event: formatEvent(event) }));
  });
}
