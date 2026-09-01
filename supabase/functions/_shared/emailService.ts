// Sends transactional email through Resend (https://resend.com) - the
// provider chosen for Feature Registry's email setup (the app previously
// had no email channel at all; only in-app notifications + push).
//
// Setup: create a Resend account, verify a sending domain (or use their
// resend.dev sandbox address for testing - see the caveat below), grab an
// API key, then:
//   supabase secrets set RESEND_API_KEY='re_your_key_here'
//   supabase secrets set EMAIL_FROM='Horizon <notifications@yourdomain.com>'
//
// Caveat while EMAIL_FROM is left unset/on the sandbox default
// ("onboarding@resend.dev"): Resend's sandbox sender can only deliver to
// the email address the Resend ACCOUNT itself is registered under, not to
// real end users - fine for smoke-testing this integration, not for
// production use. Verify a real domain in the Resend dashboard and set
// EMAIL_FROM to an address on it before relying on this for actual users.
//
// Mirrors pushService.ts's shape deliberately: a single sendEmail()
// primitive, and every failure is caught by the caller (see
// notificationService.ts's "important" hook) rather than thrown all the
// way up - a missing/invalid Resend key should never take down the in-app
// notification or push that triggered it.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Horizon <onboarding@resend.dev>";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
};

/// Sends one email via Resend's REST API. Throws on failure (missing API
/// key, Resend rejects the request, network error) - callers that treat
/// email as a "nice to have" alongside push should catch/log, not let this
/// fail the notification that triggered it (see notifyUser's "important"
/// branch for the pattern to follow).
export async function sendEmail(message: EmailMessage): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY secret is not set - email can't be sent.");
  }
  const from = Deno.env.get("EMAIL_FROM") || DEFAULT_FROM;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
    }),
  });

  if (!res.ok) {
    // deno-lint-ignore no-explicit-any
    const body: any = await res.json().catch(() => ({}));
    throw new Error(`Resend send failed (${res.status}): ${body?.message || JSON.stringify(body)}`);
  }
}

/// Wraps a plain-text-ish body in a minimal, readable HTML shell - most
/// call sites just have a title + a sentence or two, not real HTML content,
/// so this is simpler than hand-writing markup at every call site.
export function simpleEmailHtml({ heading, body }: { heading: string; body: string }): string {
  const escapedBody = body
    .split("\n")
    .map((line) => `<p style="margin:0 0 12px;">${line}</p>`)
    .join("");
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="margin: 0 0 16px; font-size: 18px;">${heading}</h2>
      ${escapedBody}
      <p style="margin: 24px 0 0; font-size: 12px; color: #888;">This is an automated message from Horizon.</p>
    </div>
  `;
}
