import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Sends push notifications through Firebase Cloud Messaging's HTTP v1 API.
// FCM's older server-key API (fcm.googleapis.com/fcm/send) was shut down by
// Google in 2024 - v1 is the only option now, and it authenticates with a
// short-lived OAuth2 access token obtained via a service account, not a
// static server key. That's what most of this file is: the standard
// "service account JWT bearer" exchange, using only Web Crypto + fetch (no
// google-auth-library) so it has no Node-specific dependencies running in
// the Deno edge runtime.
//
// Setup (see the deploy notes shared alongside this file): download a
// service account key from Firebase Console -> Project Settings -> Service
// Accounts -> Generate new private key, then:
//   supabase secrets set FIREBASE_SERVICE_ACCOUNT='<the whole JSON, one line>'

export type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

let cachedServiceAccount: ServiceAccount | null = null;

export function getServiceAccount(): ServiceAccount {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT secret is not set - push notifications can't be sent."
    );
  }
  cachedServiceAccount = JSON.parse(raw) as ServiceAccount;
  return cachedServiceAccount;
}

function base64UrlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(str: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(str));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Service account JSON stores the key with literal "\n" escapes when it's
  // been through an env var / secrets manager round-trip rather than read
  // straight from the downloaded file - normalize either form.
  const normalized = pem.replace(/\\n/g, "\n");
  const contents = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(contents), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Cached in memory for this function instance's lifetime - a token is valid
// for an hour, so a warm instance handling several message notifications in
// a row reuses it instead of re-signing a JWT and round-tripping to Google
// on every single push.
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const serviceAccount = getServiceAccount();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(
    JSON.stringify(claims)
  )}`;

  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlFromBytes(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )}&assertion=${jwt}`,
  });
  // deno-lint-ignore no-explicit-any
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to get Google access token: ${data.error_description || data.error || res.status}`
    );
  }

  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

export type PushNotification = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

/// Sends a push notification to every device registered to [uid]. Silently
/// does nothing (not an error) if the user has no registered devices - e.g.
/// an iPhone user, since iOS push isn't wired up on the client yet, or
/// someone who's simply never granted notification permission. Prunes any
/// token FCM reports as no-longer-valid (app uninstalled, data cleared) so
/// device_tokens doesn't accumulate dead rows forever.
export async function sendPushToUser(
  supabase: SupabaseClient,
  uid: string,
  notification: PushNotification
): Promise<void> {
  const { data: tokens, error } = await supabase
    .from("device_tokens")
    .select("token")
    .eq("uid", uid);
  if (error) throw error;
  if (!tokens || tokens.length === 0) return;

  const serviceAccount = getServiceAccount();
  const accessToken = await getAccessToken();

  await Promise.all(
    tokens.map(async ({ token }: { token: string }) => {
      try {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token,
                notification: { title: notification.title, body: notification.body },
                data: notification.data ?? {},
                android: { priority: "high" },
              },
            }),
          }
        );

        if (!res.ok) {
          // deno-lint-ignore no-explicit-any
          const body: any = await res.json().catch(() => ({}));
          const status = body?.error?.status;
          if (status === "UNREGISTERED" || status === "NOT_FOUND" || status === "INVALID_ARGUMENT") {
            await supabase.from("device_tokens").delete().eq("token", token);
          } else {
            console.error(`FCM send failed for token ${token.slice(0, 12)}...:`, body);
          }
        }
      } catch (err) {
        console.error(`FCM send threw for token ${token.slice(0, 12)}...:`, err);
      }
    })
  );
}

export type PushDiagnostics = {
  serviceAccountConfigured: boolean;
  serviceAccountError: string | null;
  deviceTokenCount: number;
  sendResults: Array<{ tokenPreview: string; ok: boolean; error?: string }>;
};

/// Self-test for "push isn't working, don't know if I'm doing something
/// wrong" - most of what can go wrong here (FIREBASE_SERVICE_ACCOUNT secret
/// never set, no device registered, a stale/uninstalled-app token) is
/// otherwise invisible: sendPushToUser deliberately swallows every failure
/// so a push hiccup never breaks the in-app notification that triggered
/// it, which means nothing in the app itself ever tells you push is
/// broken. This runs the exact same steps against the CALLING admin's own
/// account and actually reports each one, instead of only logging to the
/// Edge Function console. Always self-targeted (uses the admin's own uid,
/// same reasoning as /account/mfa/clear-unverified) - this is a "test my
/// own phone" tool, not a way to probe another user's device state.
export async function runPushDiagnostics(supabase: SupabaseClient, uid: string): Promise<PushDiagnostics> {
  let serviceAccountConfigured = true;
  let serviceAccountError: string | null = null;
  let serviceAccount: ServiceAccount | null = null;
  let accessToken: string | null = null;

  try {
    serviceAccount = getServiceAccount();
    accessToken = await getAccessToken();
  } catch (err) {
    serviceAccountConfigured = false;
    serviceAccountError = err instanceof Error ? err.message : String(err);
  }

  const { data: tokens, error } = await supabase.from("device_tokens").select("token").eq("uid", uid);
  if (error) throw error;
  const deviceTokenCount = tokens?.length ?? 0;

  const sendResults: PushDiagnostics["sendResults"] = [];

  if (accessToken && serviceAccount && tokens && tokens.length > 0) {
    for (const { token } of tokens as Array<{ token: string }>) {
      const tokenPreview = `${token.slice(0, 12)}...`;
      try {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token,
                notification: {
                  title: "Test push",
                  body: "If you see this, push notifications are working on this device.",
                },
                android: { priority: "high" },
              },
            }),
          }
        );
        if (res.ok) {
          sendResults.push({ tokenPreview, ok: true });
        } else {
          // deno-lint-ignore no-explicit-any
          const body: any = await res.json().catch(() => ({}));
          sendResults.push({
            tokenPreview,
            ok: false,
            error: body?.error?.message || body?.error?.status || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        sendResults.push({
          tokenPreview,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { serviceAccountConfigured, serviceAccountError, deviceTokenCount, sendResults };
}
