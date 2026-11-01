// Verifies Managed Agents webhook deliveries.
//
// Headers are webhook-id / webhook-timestamp / webhook-signature with a whsec_
// secret, which is the Standard Webhooks scheme: HMAC-SHA256 over
// "<id>.<timestamp>.<raw body>", keyed with the base64 bytes after "whsec_",
// signature header "v1,<base64>" (space-separated list).
// VERIFY in Phase 0: send a test event from the Console and confirm this passes.
// If it doesn't, swap in the SDK's client.beta.webhooks.unwrap(rawBody, { headers }).

const TOLERANCE_SECONDS = 5 * 60;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Compares two strings without leaking, through timing, how much of them matches. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function sign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const keyBytes = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return bytesToB64(mac);
}

export async function verifyWebhook(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(nowSeconds - tsNum) > TOLERANCE_SECONDS) return false;
  const expected = await sign(secret, id, ts, rawBody);
  return sigHeader
    .split(" ")
    .map((s) => s.split(",", 2))
    .some(([v, sig]) => v === "v1" && !!sig && timingSafeEqual(sig, expected));
}
