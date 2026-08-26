// Wraps Supabase Edge Runtime's `EdgeRuntime.waitUntil` global, which lets a
// function return its response immediately while finishing async work
// afterwards - used by the webhooks function to ack Paystack fast (avoiding
// their retry-on-timeout behavior) while still processing the event, same
// as the old Express handler's `res.sendStatus(200)` before its try/catch.
//
// Accessed via a runtime property lookup rather than an ambient `declare
// const EdgeRuntime` because that global only exists inside the deployed
// Edge Runtime, not under plain `deno check`/`deno run` - this way the file
// type-checks cleanly everywhere and still degrades gracefully (task just
// runs unblocked, logged on failure) in any environment where the global
// isn't present, e.g. local `deno test`.
export function runInBackground(task: Promise<unknown>): void {
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  }).EdgeRuntime;

  const guarded = task.catch((err) => {
    console.error("Background task failed:", err instanceof Error ? err.message : err);
  });

  if (runtime?.waitUntil) {
    runtime.waitUntil(guarded);
  }
  // If the global isn't present, `guarded` is already running - nothing
  // else to do; we just can't guarantee it survives past the response in
  // that environment (only matters outside the real Edge Runtime).
}
