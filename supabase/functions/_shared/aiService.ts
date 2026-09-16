// AI assistant plumbing (Item 3 - dispute triage, natural-language search,
// fraud pattern flagging, listing help/pricing suggestions, FAQ chatbot).
//
// Hard constraint from the product owner: the AI never takes any action by
// itself - every feature here only produces a suggestion/flag for a human
// (an admin, or the posting user for listing help) to look at and decide on.
// Nothing in this file writes to wallets, agreements, account status, or
// anything else money- or trust-affecting - see ai/index.ts, which is the
// only thing that calls this module, for the read-only/advisory-only shape
// of every route.
//
// Deliberately lazy/non-throwing (unlike getAdminWalletUid's requireSecret
// pattern) - isAiEnabled() lets every caller check first and return a plain
// "not turned on yet" response instead of a 500, so the whole feature can
// ship dormant (no ANTHROPIC_API_KEY secret set) without affecting any
// existing flow, exactly as requested. Turning it on later is just
// `supabase secrets set ANTHROPIC_API_KEY=...` - no code or deploy needed.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Cheapest current model by default, since every one of these features is
// advisory text generation, not something that needs top-tier reasoning -
// keeps the per-call cost low once the owner does turn this on. Overridable
// via the optional ANTHROPIC_MODEL secret if they want a different one.
const DEFAULT_MODEL = "claude-3-5-haiku-latest";

export function isAiEnabled(): boolean {
  return Boolean(Deno.env.get("ANTHROPIC_API_KEY"));
}

function getModel(): string {
  return Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;
}

export class AiDisabledError extends Error {
  constructor() {
    super("AI assistance isn't turned on yet.");
    this.name = "AiDisabledError";
  }
}

/// Raw text completion. Throws AiDisabledError if no API key is configured -
/// every route handler in ai/index.ts checks isAiEnabled() first and returns
/// a 200 {enabled:false} instead of calling this, so in practice this only
/// throws on an actual Anthropic API failure (rate limit, bad key, outage).
export async function callClaude({
  system,
  prompt,
  maxTokens = 1024,
}: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new AiDisabledError();

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const block = Array.isArray(data?.content) ? data.content.find((b: { type: string }) => b.type === "text") : null;
  const out = block?.text;
  if (typeof out !== "string") throw new Error("Anthropic API returned no text content");
  return out;
}

/// Same as callClaude, but instructs the model to answer with ONLY a JSON
/// object and parses it. Used for the structured features (search-parse,
/// listing-help, fraud-scan) where the caller needs fields, not prose. Falls
/// back to null on a parse failure rather than throwing - a malformed model
/// response should degrade to "no suggestion" for the caller, never a 500.
export async function callClaudeJson<T>({
  system,
  prompt,
  maxTokens = 1024,
}: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<T | null> {
  const jsonSystem = `${system}\n\nRespond with ONLY a single valid JSON object - no markdown fences, no commentary before or after it.`;
  const text = await callClaude({ system: jsonSystem, prompt, maxTokens });
  try {
    // Models occasionally wrap JSON in a fenced code block despite being
    // told not to - strip fences before parsing rather than failing on them.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.error("Failed to parse AI JSON response:", err, "raw:", text.slice(0, 500));
    return null;
  }
}
