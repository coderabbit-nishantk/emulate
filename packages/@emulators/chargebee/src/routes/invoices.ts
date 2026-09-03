import type { RouteContext } from "@emulators/core";
import { formatInvoice } from "../formatters.js";
import { chargebeeList, fieldOf, matchesFilters, notEmulated, notFound, readFilters } from "../helpers.js";
import { getChargebeeStore } from "../store.js";

export function invoiceRoutes({ app, store }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.get("/api/v2/invoices/:id", (c) => {
    const invoice = cs.invoices.findOneBy("chargebee_id", c.req.param("id"));
    if (!invoice) return notFound(c);
    return c.json({ invoice: formatInvoice(invoice) });
  });

  app.get("/api/v2/invoices", (c) => {
    const filters = readFilters(c, ["id", "customer_id", "subscription_id", "status", "date"]);
    const rows = cs.invoices
      .all()
      .filter((invoice) =>
        matchesFilters(filters, (field) => (field === "id" ? invoice.chargebee_id : fieldOf(invoice, field))),
      )
      .sort((left, right) => left.date - right.date || left.id - right.id);

    return chargebeeList(c, rows, (invoice) => ({ invoice: formatInvoice(invoice) }));
  });

  // Refunds, credit notes and collection retries all turn on allocation and retry
  // rules that Chargebee does not publish. They are refused so that a scenario
  // depending on them fails visibly instead of passing against invented figures.
  app.post("/api/v2/invoices/:id/refund", (c) =>
    notEmulated(c, "invoice refunds", "refund allocation across line items is not publicly specified"),
  );

  app.post("/api/v2/invoices/:id/collect_payment", (c) =>
    notEmulated(c, "payment collection and dunning", "retry ladders and gateway behavior are not publicly specified"),
  );

  app.post("/api/v2/credit_notes", (c) =>
    notEmulated(c, "credit notes", "credit allocation and refund ordering are not publicly specified"),
  );

  app.post("/api/v2/estimates/create_subscription_for_items", (c) =>
    notEmulated(
      c,
      "estimates",
      "estimate arithmetic is the provider's pricing engine and cannot be reproduced faithfully",
    ),
  );

  app.post("/api/v2/estimates/update_subscription_for_items", (c) =>
    notEmulated(
      c,
      "estimates",
      "estimate arithmetic is the provider's pricing engine and cannot be reproduced faithfully",
    ),
  );

  app.post("/api/v2/usages", (c) =>
    notEmulated(c, "metered usage", "usage aggregation windows and rounding are not publicly specified"),
  );
}
