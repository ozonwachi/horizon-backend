import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, requireAdmin, type AppEnv } from "../_shared/auth.ts";
import { isAiEnabled, callClaude, callClaudeJson } from "../_shared/aiService.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";
import { getAgreement } from "../_shared/escrowService.ts";
import { listAuditLogs } from "../_shared/auditLogService.ts";
import { getEscrowConversation } from "../_shared/conversationService.ts";
import { listAllFaqs } from "../_shared/faqService.ts";

// AI assistant (Item 3). Every route here is advisory only - see
// _shared/aiService.ts's doc comment for the hard "never takes action
// itself" constraint. Every route also checks isAiEnabled() first and
// returns a plain 200 {enabled:false} rather than a 500 when the
// ANTHROPIC_API_KEY secret isn't set, so the whole feature ships dormant
// without affecting any other flow until the owner turns it on.
const app = new Hono<AppEnv>().basePath("/ai");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.get("/status", (c) => c.json({ enabled: isAiEnabled() }));

// ---------------------------------------------------------------------------
// 1. Dispute triage (admin only) - summarizes a disputed deal's evidence
//    (audit history + buyer/seller conversation) and suggests a resolution.
//    The admin still has to actually resolve the tranche themselves via the
//    existing adminResolveTranche flow - this only writes a suggestion row,
//    never touches the agreement/tranche/wallets.
// ---------------------------------------------------------------------------
app.post("/dispute-triage", requireAdmin, async (c) => {
  const supabase = getAdminClient();
  if (!isAiEnabled()) return c.json({ enabled: false });

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const agreementId = body?.agreementId;
  if (!agreementId) return c.json({ error: "agreementId is required" }, 400);

  const limited = await rateLimitOrRespond(supabase, `ai-dispute-triage:${user.uid}`, { max: 30, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const agreement = await getAgreement(supabase, agreementId);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);

    const [auditLog, conversation] = await Promise.all([
      listAuditLogs(supabase, { agreementId, limit: 50 }),
      getEscrowConversation(supabase, agreement.buyerId, agreement.sellerId, agreement.id),
    ]);

    const disputedTranches = (agreement.tranches || []).filter((t: { status: string }) => t.status === "disputed");

    const prompt = [
      `Deal: "${agreement.title}" - ${agreement.description || "(no description)"}`,
      `Total amount: ${agreement.amountKobo / 100} NGN`,
      "",
      "Disputed tranche(s):",
      ...disputedTranches.map(
        (t: { label: string; amountKobo: number; disputeReason?: string }) =>
          `- "${t.label}" (${t.amountKobo / 100} NGN): dispute reason - ${t.disputeReason || "(none given)"}`
      ),
      "",
      `Admin action history (${auditLog.length} entries, most recent first):`,
      ...auditLog
        .slice(0, 30)
        .map((e) => `- [${e.createdAt}] ${e.action}${e.reason ? ` (${e.reason})` : ""}: ${JSON.stringify(e.newValue ?? {})}`),
      "",
      "Buyer/seller conversation (chronological):",
      ...conversation.messages.slice(-60).map((m) => `- ${m.senderId === agreement.buyerId ? "Buyer" : "Seller"}: ${m.text}`),
    ].join("\n");

    const suggestion = await callClaude({
      system:
        "You are an assistant helping a human marketplace admin decide how to resolve an escrow payment dispute. " +
        "You do NOT have the authority to resolve anything yourself - you are only producing a written suggestion " +
        "for the admin to read and act on (or ignore) themselves. Be concise (under 200 words): summarize what each " +
        "side seems to want, note anything that looks inconsistent or suspicious in the evidence, and suggest a " +
        "resolution (release to seller / refund to buyer / split) with your confidence and reasoning. Never claim " +
        "to be taking any action - you are only advising.",
      prompt,
      maxTokens: 600,
    });

    const { data: row, error } = await supabase
      .from("ai_dispute_suggestions")
      .insert({
        agreement_id: agreementId,
        tranche_id: disputedTranches[0]?.id || null,
        suggestion,
        requested_by: user.uid,
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest",
      })
      .select("*")
      .single();
    if (error) throw error;

    return c.json({ enabled: true, suggestion, id: row.id, model: row.model, createdAt: row.created_at });
  } catch (err) {
    console.error("AI dispute triage failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/dispute-triage", requireAdmin, async (c) => {
  const supabase = getAdminClient();
  const agreementId = c.req.query("agreementId");
  if (!agreementId) return c.json({ error: "agreementId is required" }, 400);
  try {
    const { data, error } = await supabase
      .from("ai_dispute_suggestions")
      .select("*")
      .eq("agreement_id", agreementId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return c.json(
      (data || []).map((r) => ({ id: r.id, suggestion: r.suggestion, model: r.model, createdAt: r.created_at }))
    );
  } catch (err) {
    console.error("List AI dispute suggestions failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// 2. Fraud pattern flagging (admin only, admin-triggered). Deliberately not
//    a cron job - an on-demand "Run scan" button keeps the (paid, once
//    enabled) API cost bounded and under the admin's control, rather than
//    something that quietly runs on a schedule. Scans the most recent
//    listings; flags are written for a human to review/resolve, never acted
//    on automatically (no account/listing is ever touched by this route).
// ---------------------------------------------------------------------------
type FraudFlagCandidate = { listingId: string; reason: string; severity: "low" | "medium" | "high" };

app.post("/fraud-scan", requireAdmin, async (c) => {
  const supabase = getAdminClient();
  if (!isAiEnabled()) return c.json({ enabled: false });

  const user = c.get("user");
  const limited = await rateLimitOrRespond(supabase, "ai-fraud-scan", { max: 12, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const { data: listings, error } = await supabase
      .from("listings")
      .select("id, title, description, price, category, owner_id, owner_trust_level, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    if (!listings || listings.length === 0) return c.json({ enabled: true, flags: [] });

    const prompt = [
      "Review these recently-posted marketplace listings for signs of a scam or fraud pattern - e.g. a price far " +
        "below plausible market value for the stated item with a vague/generic description, a high-value category " +
        "(Vehicles/Property) posted by a low-trust account, or wording that resembles a known scam template. Most " +
        "listings are legitimate - only flag ones that actually look suspicious, don't flag something just because " +
        "it's cheap or brief.",
      "",
      ...listings.map(
        (l) =>
          `id=${l.id} | category=${l.category} | price=${l.price} | ownerTrust=${l.owner_trust_level} | ` +
          `title="${l.title}" | description="${(l.description || "").slice(0, 200)}"`
      ),
    ].join("\n");

    const result = await callClaudeJson<{ flags: FraudFlagCandidate[] }>({
      system:
        'Respond with JSON: {"flags": [{"listingId": string, "reason": string, "severity": "low"|"medium"|"high"}]}. ' +
        "Only include listings you're genuinely flagging - omit anything you're not suspicious of. Empty array if " +
        "nothing looks suspicious.",
      prompt,
      maxTokens: 1500,
    });

    const candidates = (result?.flags || []).filter((f) => listings.some((l) => l.id === f.listingId));
    if (candidates.length === 0) return c.json({ enabled: true, flags: [] });

    const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
    const { data: inserted, error: insertError } = await supabase
      .from("ai_fraud_flags")
      .insert(
        candidates.map((f) => ({
          subject_type: "listing",
          subject_id: f.listingId,
          reason: f.reason,
          severity: f.severity,
          model,
        }))
      )
      .select("*");
    if (insertError) throw insertError;

    return c.json({ enabled: true, flags: inserted, scannedBy: user.uid });
  } catch (err) {
    console.error("AI fraud scan failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/fraud-flags", requireAdmin, async (c) => {
  const supabase = getAdminClient();
  const resolvedParam = c.req.query("resolved");
  try {
    let query = supabase.from("ai_fraud_flags").select("*").order("created_at", { ascending: false }).limit(200);
    if (resolvedParam !== undefined) query = query.eq("resolved", resolvedParam === "true");
    const { data, error } = await query;
    if (error) throw error;
    return c.json(data || []);
  } catch (err) {
    console.error("List AI fraud flags failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/fraud-flags/:id/resolve", requireAdmin, async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const { data, error } = await supabase
      .from("ai_fraud_flags")
      .update({ resolved: true, resolved_by: user.uid, resolved_at: new Date().toISOString(), resolution_note: body?.note || null })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return c.json(data);
  } catch (err) {
    console.error("Resolve AI fraud flag failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// 3. Natural-language search parsing (any signed-in user). Turns a
//    free-text query into structured filters the app already knows how to
//    apply (category/price/type/keywords) - the AI never runs the search or
//    picks results itself, it only suggests filter values the user sees
//    applied and can change like any other filter.
// ---------------------------------------------------------------------------
app.post("/search-parse", async (c) => {
  const supabase = getAdminClient();
  if (!isAiEnabled()) return c.json({ enabled: false });

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const query = (body?.query || "").trim();
  const categories: string[] = Array.isArray(body?.categories) ? body.categories : [];
  if (!query) return c.json({ error: "query is required" }, 400);

  const limited = await rateLimitOrRespond(supabase, `ai-search-parse:${user.uid}`, { max: 40, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const result = await callClaudeJson<{
      category: string | null;
      minPrice: number | null;
      maxPrice: number | null;
      type: "listing" | "job" | "barter" | null;
      keywords: string;
    }>({
      system:
        `You turn a shopper's free-text search into structured filters for a marketplace app. Valid categories: ` +
        `${JSON.stringify(categories)} (use null if none clearly match). "type" is "listing", "job", "barter", or ` +
        `null for "search everything". minPrice/maxPrice are in Naira, null if not implied. "keywords" is a short ` +
        `plain-text search phrase (strip filler words like "find me" / "looking for").`,
      prompt: `Query: "${query}"`,
      maxTokens: 300,
    });

    if (!result) return c.json({ enabled: true, category: null, minPrice: null, maxPrice: null, type: null, keywords: query });
    return c.json({ enabled: true, ...result });
  } catch (err) {
    console.error("AI search-parse failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// 4. Listing help / pricing suggestions (any signed-in user, while posting).
//    Purely suggestive - the Sell screen shows this as a card the seller can
//    apply or dismiss, never auto-fills the form.
// ---------------------------------------------------------------------------
app.post("/listing-help", async (c) => {
  const supabase = getAdminClient();
  if (!isAiEnabled()) return c.json({ enabled: false });

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const { title, description, category } = body || {};
  if (!title || !category) return c.json({ error: "title and category are required" }, 400);

  const limited = await rateLimitOrRespond(supabase, `ai-listing-help:${user.uid}`, { max: 30, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const result = await callClaudeJson<{
      suggestedMinPriceNaira: number | null;
      suggestedMaxPriceNaira: number | null;
      priceReasoning: string;
      improvedDescription: string;
      tips: string[];
    }>({
      system:
        "You help a marketplace seller price and describe their listing better. Suggest a plausible Naira price " +
        "range for the Nigerian market (null for both if you genuinely can't estimate - e.g. a service with no " +
        "comparable), a one-sentence reason, an improved version of their description (clearer, more complete, " +
        "still honest - never invent facts about the item they didn't state), and up to 3 short tips.",
      prompt: `Category: ${category}\nTitle: ${title}\nDescription: ${description || "(none written yet)"}`,
      maxTokens: 700,
    });

    if (!result) return c.json({ enabled: true, suggestedMinPriceNaira: null, suggestedMaxPriceNaira: null, priceReasoning: "", improvedDescription: "", tips: [] });
    return c.json({ enabled: true, ...result });
  } catch (err) {
    console.error("AI listing-help failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// 5. FAQ chatbot (any signed-in user). Grounded in the real FAQ list so it
//    answers from what's actually true about this app rather than
//    guessing/hallucinating, and explicitly forbidden from claiming to take
//    any action on the user's behalf.
// ---------------------------------------------------------------------------
app.post("/faq-chat", async (c) => {
  const supabase = getAdminClient();
  if (!isAiEnabled()) return c.json({ enabled: false });

  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const message = (body?.message || "").trim();
  const history: Array<{ role: string; text: string }> = Array.isArray(body?.history) ? body.history.slice(-10) : [];
  if (!message) return c.json({ error: "message is required" }, 400);

  const limited = await rateLimitOrRespond(supabase, `ai-faq-chat:${user.uid}`, { max: 60, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const faqs = await listAllFaqs(supabase);
    const faqContext = faqs
      .slice(0, 40)
      .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
      .join("\n\n");

    const transcript = history.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n");

    const reply = await callClaude({
      system:
        "You are a help assistant inside a marketplace app (buying/selling/jobs/barter with escrow payments). " +
        "Answer questions about how the app works, using the FAQ list below as your source of truth where it " +
        "applies. You must NEVER claim to perform an action on the user's behalf - you cannot approve, refund, " +
        "ban, verify, or change anything. If the user needs something actually done (a refund, a dispute, account " +
        "help), tell them to use the in-app 'Contact Admin' option instead of pretending to do it yourself. Keep " +
        "answers short and plain.\n\nFAQs:\n" + faqContext,
      prompt: `${transcript ? transcript + "\n" : ""}User: ${message}`,
      maxTokens: 500,
    });

    return c.json({ enabled: true, reply });
  } catch (err) {
    console.error("AI FAQ chat failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

Deno.serve(app.fetch);
