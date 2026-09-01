import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// See migration_26's doc comment for the overall design and its important
// limitation (this can't reach Supabase Auth's own login endpoint - only
// routes that actually go through one of our Edge Functions).

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/// Throws RateLimitError if [key] has already hit [max] calls within the
/// last [windowSeconds]. Call this at the top of a route handler, after
/// requireAuth has set c.get("user") (so [key] can be scoped to a specific
/// user, e.g. `withdrawal:${uid}`) - a shared/global key works too for
/// something not tied to a single user.
export async function enforceRateLimit(
  supabase: SupabaseClient,
  key: string,
  { max, windowSeconds }: { max: number; windowSeconds: number }
): Promise<void> {
  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
    p_key: key,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    // Fails OPEN, not closed - a rate-limit-check outage should never be
    // the reason a legitimate user can't withdraw their own money or an
    // admin can't act. Logged so it's visible, never silently ignored.
    console.error(`Rate limit check failed for key "${key}" - allowing through:`, error);
    return;
  }
  if (data !== true) {
    throw new RateLimitError("Too many requests - please wait a bit and try again.");
  }
}

/// Hono route helper: wraps enforceRateLimit and turns a RateLimitError
/// into the standard 429 JSON response, so route handlers don't each need
/// their own try/catch just for this.
// deno-lint-ignore no-explicit-any
export async function rateLimitOrRespond(
  supabase: SupabaseClient,
  key: string,
  opts: { max: number; windowSeconds: number },
  // deno-lint-ignore no-explicit-any
  c: any
): Promise<Response | null> {
  try {
    await enforceRateLimit(supabase, key, opts);
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json({ error: err.message }, 429);
    }
    throw err;
  }
}
