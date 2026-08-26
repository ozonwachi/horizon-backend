import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// The service_role key bypasses Row Level Security entirely - this is the
// backend's equivalent of the old firebaseAdmin.js Admin SDK access, carried
// over unchanged from src/config/supabaseAdmin.js when the Express server
// still existed. Every function in this project does 100% of its Postgres
// access through this one client, with authorization enforced entirely in
// application code (requireAuth/requireAdmin in ./auth.ts) - never through
// RLS at the point of call from here. That's a deliberate continuation of
// how the Express backend worked, not a shortcut: it means this file's
// authorization checks are the only thing standing between a request and
// the database, so treat requireAuth/requireAdmin as load-bearing.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY don't need `supabase secrets
// set` - the Edge Runtime injects both automatically for every function.
// Everything else this project needs (PAYSTACK_SECRET_KEY, ADMIN_WALLET_UID,
// ALLOWED_ORIGINS) does need to be set explicitly - see the deployment
// runbook.
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `${name} is not set. Set it with \`supabase secrets set ${name}=...\`, ` +
        "or add it to supabase/functions/.env for local dev."
    );
  }
  return value;
}

let cachedClient: SupabaseClient | null = null;

// Edge Functions can keep a warm instance between invocations, so caching
// the client (like the old supabaseAdmin.js's module-level singleton) saves
// re-creating it on every request within the same warm instance - it's
// re-created fresh on cold start either way.
export function getAdminClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

export function requireSecret(name: string): string {
  return requireEnv(name);
}
