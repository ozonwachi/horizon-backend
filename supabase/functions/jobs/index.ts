import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { notifyUser, notifyUsers } from "../_shared/notificationService.ts";

// Feature Registry items #63/#64 (Job + Nearby Opportunity Notifications).
// The Flutter app writes a new job straight to Postgres (see
// JobRepository.createJob) - there's no backend hook on that write, so
// nothing ever told anyone a matching job went up nearby. This is that
// missing notify step, same shape as /conversations/:id/notify: called
// right after a successful post, fans out to whoever the
// match_job_notification_candidates() SQL function (see
// project_supabase_migration_13_job_alerts_and_user_reports.sql, wildcard
// refinement in migration_14) says is a match - someone who listed a
// role/skill (e.g. "Plumber") that shows up in this job's title or
// category (or who's tagged the generalist "Job Seeker", which matches
// everything), within their own notification radius of their own
// notification location (not live GPS - see migration_13's comment for
// why this has to be a location the user set ahead of time).
//
// Direction only runs one way: jobs.is_service_offer distinguishes a
// CLIENT looking for a skillsman (false) from a SKILLSMAN advertising
// themselves (true) - only the former fans out here (see the
// is_service_offer check below). A plumber's own service ad doesn't ping
// other plumbers; it's discovered through Find a Service / search instead.
const app = new Hono<AppEnv>().basePath("/jobs");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

const NOTIFY_RADIUS_KM = 30;

app.post("/:id/notify-matches", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("id");
  const supabase = getAdminClient();

  try {
    const { data: job, error } = await supabase
      .from("jobs")
      .select(
        "id, poster_id, title, category, latitude, longitude, location_label, is_service_offer, state"
      )
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw error;
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    // Only the poster can trigger a fan-out for their own job - keeps this
    // from becoming a way to spam notifications at other users.
    if (job.poster_id !== user.uid) {
      return c.json({ error: "Only the poster can notify matches for this job" }, 403);
    }

    // Direction matters (see this function's doc comment): a service offer
    // is a SKILLSMAN advertising themselves, not a client with a job to
    // fill - pinging other skillsmen with the same tag about it would be
    // noise (a competitor's ad), not a lead. Only a regular job posting
    // (someone looking FOR a skillsman) fans out. The Flutter client
    // already skips calling this route for a service offer; this is the
    // server-side backstop in case anything else ever calls it directly.
    if (job.is_service_offer) {
      return c.json({ ok: true, notified: 0 });
    }

    // Nothing to match against without coordinates - PostJobScreen already
    // requires a resolved location before it lets a post through, so this
    // is just a defensive no-op, not an expected path.
    if (job.latitude == null || job.longitude == null) {
      return c.json({ ok: true, notified: 0 });
    }

    const { data: matches, error: matchError } = await supabase.rpc(
      "match_job_notification_candidates",
      {
        p_poster_id: job.poster_id,
        p_lat: job.latitude,
        p_lng: job.longitude,
        p_title: job.title,
        p_category: job.category,
        // Item: state-scoped alerts - a person in Abuja should not see a
        // job in Lagos unless they change location to Lagos. The SQL
        // function requires an exact state match when both this job's
        // state and a candidate's notify_state are known, and only falls
        // back to the plain radius check below when either side's state
        // is unresolved (older rows, or reverse geocoding didn't return
        // one) - see migration_23.
        p_state: job.state ?? null,
        p_radius_km: NOTIFY_RADIUS_KM,
      }
    );
    if (matchError) throw matchError;

    const uids = ((matches || []) as Array<{ uid: string }>).map((row) => row.uid);

    if (uids.length > 0) {
      await notifyUsers(supabase, uids, {
        type: "job_nearby",
        title: `New nearby opportunity: ${job.title}`,
        body: job.location_label ? `${job.category} · ${job.location_label}` : job.category,
        relatedType: "job",
        relatedId: job.id,
      });
    }

    return c.json({ ok: true, notified: uids.length });
  } catch (err) {
    console.error("Notify job matches failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Task: job applications (see migration_20). A regular job post
// (is_service_offer false) can have many applicants; the poster reviews
// and accepts one, which is what lets them open an escrow deal with that
// specific person (see JobApplicantsScreen/CustomDealScreen on the client
// - no escrow changes needed, the poster just becomes the caller/buyer
// against the accepted applicant as seller). Service offers don't use any
// of this - people book those directly, same as before.

app.post("/:id/applications", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = getAdminClient();

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("name, trust_level")
      .eq("uid", user.uid)
      .maybeSingle();

    const { data: appId, error } = await supabase.rpc("apply_to_job", {
      p_job_id: jobId,
      p_applicant_id: user.uid,
      p_applicant_name: profile?.name || "Unknown",
      p_applicant_trust_level: profile?.trust_level || "basic",
      p_cover_note: body?.coverNote || "",
      p_proposed_rate: body?.proposedRate || null,
    });
    if (error) throw new Error(error.message);

    const { data: job } = await supabase
      .from("jobs")
      .select("poster_id, title")
      .eq("id", jobId)
      .maybeSingle();

    if (job?.poster_id) {
      await notifyUser(supabase, job.poster_id, {
        type: "job_application_received",
        title: `New applicant: ${job.title}`,
        body: `${profile?.name || "Someone"} applied to your job.`,
        relatedType: "job",
        relatedId: jobId,
      }).catch((err) => console.error("notifyUser (job_application_received) failed:", err));
    }

    return c.json({ id: appId }, 201);
  } catch (err) {
    console.error("Apply to job failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/applications/:applicationId/withdraw", async (c) => {
  const user = c.get("user");
  const applicationId = c.req.param("applicationId");
  const supabase = getAdminClient();

  try {
    const { error } = await supabase.rpc("withdraw_job_application", {
      p_application_id: applicationId,
      p_applicant_id: user.uid,
    });
    if (error) throw new Error(error.message);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Withdraw job application failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

const DECISION_COPY: Record<string, string> = {
  shortlisted: "You've been shortlisted for",
  accepted: "You've been accepted for",
  rejected: "Your application wasn't selected for",
};

app.patch("/applications/:applicationId/decide", async (c) => {
  const user = c.get("user");
  const applicationId = c.req.param("applicationId");
  const body = await c.req.json().catch(() => ({}));
  const status = body?.status as string | undefined;
  const supabase = getAdminClient();

  try {
    if (!status || !(status in DECISION_COPY)) {
      return c.json({ error: 'status must be one of "shortlisted", "accepted", "rejected"' }, 400);
    }

    const { data, error } = await supabase.rpc("decide_job_application", {
      p_application_id: applicationId,
      p_poster_id: user.uid,
      p_status: status,
    });
    if (error) throw new Error(error.message);

    const result = data as {
      jobId: string;
      jobTitle: string;
      applicantId: string;
      autoRejected: Array<{ id: string; applicantId: string }>;
    };

    await notifyUser(supabase, result.applicantId, {
      type: "job_application_decided",
      title: `${DECISION_COPY[status]} "${result.jobTitle}"`,
      body:
        status === "accepted"
          ? "The poster will reach out to start the paid deal."
          : status === "shortlisted"
          ? "The poster is taking a closer look at your application."
          : "Thanks for applying - the poster went with someone else this time.",
      relatedType: "job",
      relatedId: result.jobId,
    }).catch((err) => console.error("notifyUser (job_application_decided) failed:", err));

    if (result.autoRejected?.length) {
      await notifyUsers(
        supabase,
        result.autoRejected.map((r) => r.applicantId),
        {
          type: "job_application_decided",
          title: `Your application wasn't selected for "${result.jobTitle}"`,
          body: "The poster filled this job with another applicant.",
          relatedType: "job",
          relatedId: result.jobId,
        }
      ).catch((err) => console.error("notifyUsers (auto-rejected applicants) failed:", err));
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("Decide job application failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
