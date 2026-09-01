import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Thin wrapper around get_platform_analytics() (migration_19) - a single
// SQL function computing every aggregate the Admin Analytics screen shows,
// in one round trip. See that function's body for exactly what's counted
// and summed; this module just calls it and returns the jsonb as-is (the
// shape already matches what the Dart PlatformAnalytics.fromJson expects,
// camelCase keys built directly by jsonb_build_object).
export async function getPlatformAnalytics(supabase: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("get_platform_analytics");
  if (error) throw error;
  return data as Record<string, unknown>;
}
