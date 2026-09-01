import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { notifyUser } from "../_shared/notificationService.ts";

// Task: barter counter-offers (see migration_21). Barter posts don't have a
// fixed price like a listing - offering/seeking is free text, so there was
// no structured way to negotiate terms before falling back to plain
// Message. This adds a single negotiation thread per (barter post,
// offerer) that either side can accept/reject/counter, with a short
// round-by-round history kept on the row (see submit_barter_offer /
// respond_barter_offer in the migration). No escrow changes needed - the
// existing "Pay with Escrow" button on barter_detail_screen already puts
// the non-poster in as buyer, which is the right direction once terms are
// agreed (see the migration's doc comment for why, unlike job
// applications, there's no direction bug to fix here).
const app = new Hono<AppEnv>().basePath("/barter");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.post("/:id/offers", async (c) => {
  const user = c.get("user");
  const barterPostId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = getAdminClient();

  try {
    const offerText = (body?.offerText || "").toString();
    const note = (body?.note || "").toString();

    const { data: profile } = await supabase
      .from("profiles")
      .select("name, trust_level")
      .eq("uid", user.uid)
      .maybeSingle();

    const { data: offerId, error } = await supabase.rpc("submit_barter_offer", {
      p_barter_post_id: barterPostId,
      p_offerer_id: user.uid,
      p_offerer_name: profile?.name || "Unknown",
      p_offerer_trust_level: profile?.trust_level || "basic",
      p_offer_text: offerText,
      p_note: note,
    });
    if (error) throw new Error(error.message);

    const { data: post } = await supabase
      .from("barter_posts")
      .select("poster_id, offering, seeking")
      .eq("id", barterPostId)
      .maybeSingle();

    if (post?.poster_id) {
      await notifyUser(supabase, post.poster_id, {
        type: "barter_offer_received",
        title: `New offer on: ${post.offering} for ${post.seeking}`,
        body: `${profile?.name || "Someone"} proposed a trade: ${offerText}`,
        relatedType: "barter",
        relatedId: barterPostId,
      }).catch((err) => console.error("notifyUser (barter_offer_received) failed:", err));
    }

    return c.json({ id: offerId }, 201);
  } catch (err) {
    console.error("Submit barter offer failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

const ACTION_COPY: Record<string, (postTitle: string) => { title: string; body: string }> = {
  accept: (t) => ({ title: `Offer accepted: ${t}`, body: "Terms agreed - head to the barter post to arrange payment/escrow if needed." }),
  reject: (t) => ({ title: `Offer declined: ${t}`, body: "The other party didn't accept these terms." }),
  counter: (t) => ({ title: `Counter-offer on: ${t}`, body: "New terms are waiting on your response." }),
  withdraw: (t) => ({ title: `Offer withdrawn: ${t}`, body: "The offerer withdrew this offer." }),
};

app.patch("/offers/:offerId/respond", async (c) => {
  const user = c.get("user");
  const offerId = c.req.param("offerId");
  const body = await c.req.json().catch(() => ({}));
  const action = body?.action as string | undefined;
  const supabase = getAdminClient();

  try {
    if (!action || !(action in ACTION_COPY)) {
      return c.json({ error: 'action must be one of "accept", "reject", "counter", "withdraw"' }, 400);
    }

    const { data, error } = await supabase.rpc("respond_barter_offer", {
      p_offer_id: offerId,
      p_responder_id: user.uid,
      p_action: action,
      p_offer_text: body?.offerText ?? null,
      p_note: body?.note ?? null,
    });
    if (error) throw new Error(error.message);

    const result = data as {
      barterPostId: string;
      postTitle: string;
      offererId: string;
      posterId: string;
      status: string;
    };

    // Notify whichever party did NOT just act - the other side of the deal.
    const actorIsPoster = user.uid === result.posterId;
    const recipient = actorIsPoster ? result.offererId : result.posterId;
    const copy = ACTION_COPY[action](result.postTitle);

    await notifyUser(supabase, recipient, {
      type: "barter_offer_decided",
      title: copy.title,
      body: copy.body,
      relatedType: "barter",
      relatedId: result.barterPostId,
    }).catch((err) => console.error("notifyUser (barter_offer_decided) failed:", err));

    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("Respond to barter offer failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
