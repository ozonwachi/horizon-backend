import { Hono } from "npm:hono@4";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";

// Public, unauthenticated pages for shared links - see share_link_service.dart
// on the Flutter side, which points ShareLinkService.baseUrl at this
// function once deployed. Anyone who taps a shared link, with or without
// the app installed, should land on a plain page showing the item's public
// details - no login, no app required. verify_jwt = false in config.toml,
// same as every other function here, and this route in particular
// deliberately needs no auth check of its own either: it's meant to be
// open to anyone, the same way the OS share sheet text (item/price/
// category/location) already is today.
//
// Reads through the service-role client rather than relying on RLS to
// allow anonymous reads, so this works regardless of how listings/jobs/
// barter_posts/escrow_agreements' SELECT policies happen to be scoped - it
// only ever surfaces the same public-facing fields the app already puts in
// plain-text shares today (title, price/rate, category, location, a
// photo), nothing sensitive like owner contact info or escrow parties.
const app = new Hono().basePath("/share");

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(opts: {
  title: string;
  subtitle: string;
  details?: string[];
  imageUrl?: string | null;
}): string {
  const { title, subtitle, imageUrl } = opts;
  const details = opts.details ?? [];
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  const detailRows = details
    .filter((d) => d.trim().length > 0)
    .map((d) => `<div class="detail">${escapeHtml(d)}</div>`)
    .join("\n      ");
  const imageTag = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${safeTitle}" class="photo" />`
    : "";
  const ogImageTag = imageUrl
    ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} - Project Horizon</title>
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeSubtitle}" />
  ${ogImageTag}
  <style>
    body {
      font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif;
      background: #f2f2f2;
      margin: 0;
      padding: 32px 16px;
      color: #1a1a1a;
    }
    .card {
      max-width: 480px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
    }
    .photo {
      width: 100%;
      height: 240px;
      object-fit: cover;
      display: block;
      background: #e0e0e0;
    }
    .content { padding: 20px 24px 24px; }
    h1 { font-size: 22px; margin: 0 0 8px; line-height: 1.3; }
    .subtitle { font-size: 15px; color: #555; margin-bottom: 16px; }
    .detail {
      font-size: 14px;
      color: #333;
      padding: 10px 0;
      border-top: 1px solid #eee;
      white-space: pre-wrap;
    }
    .badge {
      display: block;
      margin-top: 20px;
      font-size: 13px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="card">
    ${imageTag}
    <div class="content">
      <h1>${safeTitle}</h1>
      <div class="subtitle">${safeSubtitle}</div>
      ${detailRows}
      <span class="badge">Shared from Project Horizon</span>
    </div>
  </div>
</body>
</html>`;
}

function notFoundPage(kind: string): string {
  return renderPage({
    title: "Not found",
    subtitle: `This ${kind} may have been removed, or the link is incorrect.`,
  });
}

app.get("/listing/:id", async (c) => {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("listings")
    .select("title, description, price, category, location, photo_urls")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error || !data) return c.html(notFoundPage("listing"), 404);

  return c.html(
    renderPage({
      title: data.title || "Listing",
      subtitle: `₦${data.price} · ${data.category} · ${data.location}`,
      details: data.description ? [data.description] : [],
      imageUrl: (data.photo_urls ?? [])[0] ?? null,
    })
  );
});

app.get("/job/:id", async (c) => {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("title, description, pay_rate, category, location_label, photo_urls")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error || !data) return c.html(notFoundPage("job"), 404);

  return c.html(
    renderPage({
      title: data.title || "Job",
      subtitle: `${data.pay_rate || data.category} · ${data.location_label}`,
      details: data.description ? [data.description] : [],
      imageUrl: (data.photo_urls ?? [])[0] ?? null,
    })
  );
});

app.get("/barter/:id", async (c) => {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("barter_posts")
    .select("offering, seeking, description, category, location_label, photo_urls")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error || !data) return c.html(notFoundPage("barter post"), 404);

  return c.html(
    renderPage({
      title: `${data.offering} for ${data.seeking}`,
      subtitle: `${data.category} · ${data.location_label}`,
      details: data.description ? [data.description] : [],
      imageUrl: (data.photo_urls ?? [])[0] ?? null,
    })
  );
});

app.get("/deal/:id", async (c) => {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("escrow_agreements")
    .select("title, description, type, amount_kobo")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error || !data) return c.html(notFoundPage("deal"), 404);

  const label =
    data.title || `${String(data.type).charAt(0).toUpperCase()}${String(data.type).slice(1)} deal`;
  const amountNaira = ((data.amount_kobo ?? 0) / 100).toFixed(2);

  return c.html(
    renderPage({
      title: label,
      subtitle: `₦${amountNaira} · Custom deal on Project Horizon`,
      details: data.description ? [data.description] : [],
    })
  );
});

Deno.serve(app.fetch);
