import type { Context, RouteContext } from "@emulators/core";
import { escapeHtml, renderCardPage } from "@emulators/core";
import { chargebeeId, missingParam, notFound, now, parseChargebeeBody, readGroup, readString } from "../helpers.js";
import { getChargebeeStore } from "../store.js";

const SERVICE_LABEL = "Chargebee";

/**
 * Portal sessions and hosted pages exist so an application can hand a human off to
 * Chargebee. What a local scenario needs from them is a correctly shaped object and
 * a URL that actually resolves, so these point back at the emulator and render a
 * placeholder. No Chargebee-hosted UI is reproduced.
 */
export function hostedPageRoutes({ app, store, baseUrl }: RouteContext): void {
  const cs = getChargebeeStore(store);

  app.post("/api/v2/portal_sessions", async (c) => {
    const body = await parseChargebeeBody(c);
    const customerId = readString(readGroup(body, "customer"), "id") ?? readString(body, "customer_id");
    if (!customerId) throw missingParam("customer[id]");
    if (!cs.customers.findOneBy("chargebee_id", customerId)) return notFound(c);

    const at = now(cs);
    const id = chargebeeId("portal");
    return c.json({
      portal_session: {
        id,
        object: "portal_session",
        token: `${id}_token`,
        access_url: `${baseUrl}/portal/${id}`,
        status: "created",
        customer_id: customerId,
        created_at: at,
        expires_at: at + 3600,
        redirect_url: readString(body, "redirect_url"),
      },
    });
  });

  const hostedPage = async (c: Context, type: string) => {
    const body = await parseChargebeeBody(c);
    const at = now(cs);
    const id = chargebeeId("hp");
    return c.json({
      hosted_page: {
        id,
        object: "hosted_page",
        type,
        url: `${baseUrl}/hosted/${id}`,
        state: "created",
        embed: false,
        created_at: at,
        expires_at: at + 3600,
        updated_at: at,
        resource_version: at * 1000,
        redirect_url: readString(body, "redirect_url"),
      },
    });
  };

  app.post("/api/v2/hosted_pages/collect_now", (c) => hostedPage(c, "collect_now"));
  app.post("/api/v2/hosted_pages/checkout_new_for_items", (c) => hostedPage(c, "checkout_new"));
  app.post("/api/v2/hosted_pages/manage_payment_sources", (c) => hostedPage(c, "manage_payment_sources"));

  /**
   * These two are the emulator's only browser-facing pages, so the path parameter
   * is escaped before it reaches the HTML. It is attacker-controlled and reflected,
   * which is the textbook shape of a reflected XSS.
   */
  const handoffPage = (c: Context, kind: string, title: string) =>
    c.html(
      renderCardPage(
        title,
        "Emulated Chargebee hand-off page",
        `<p class="empty">${escapeHtml(kind)} <code>${escapeHtml(c.req.param("id"))}</code>. The emulator does not reproduce the hosted UI. Drive the API directly instead.</p>`,
        SERVICE_LABEL,
      ),
    );

  app.get("/portal/:id", (c) => handoffPage(c, "Session", "Customer portal"));
  app.get("/hosted/:id", (c) => handoffPage(c, "Page", "Hosted page"));
}
