import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.SESSION_SECRET = "piazza-auto-login-test-session-secret";
const { database: db } = await import("../lib/database.ts");
const { saveIntegrationConnection } = await import("../lib/repository.ts");
const { encryptPiazzaCookies } = await import("../lib/piazza.ts");
const { deletePiazzaAutoLogin, getPiazzaAutoLoginStatus, savePiazzaAutoLogin } = await import("../lib/piazza-auto-login.ts");
const { getPiazzaStatus, syncPiazza } = await import("../lib/piazza-sync.ts");

async function staleConnection() {
  await saveIntegrationConnection("piazza", encryptPiazzaCookies({ session_id: "old-session" }), { classes: [] }, "needs_reconnect");
}

test("expired Piazza session renews once and credentials stay encrypted at rest", async () => {
  await staleConnection();
  await savePiazzaAutoLogin("student@example.com", "private-password");
  const stored = await db.prepare("SELECT credentials_encrypted FROM piazza_auto_login WHERE id=1").first<{ credentials_encrypted: string }>();
  assert.ok(stored);
  assert.equal(stored.credentials_encrypted.includes("private-password"), false);
  assert.equal(JSON.stringify(await getPiazzaStatus()).includes("private-password"), false);
  let logins = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/main/csrf_token")) return new Response('csrf_token = "token"', { headers: { "Set-Cookie": "csrftoken=csrf" } });
    if (url.endsWith("/class")) { logins++; assert.match(String(init?.body), /private-password/); return new Response("ok", { headers: { "Set-Cookie": "session_id=fresh-session" } }); }
    if (url.includes("/logic/api")) {
      if (String((init?.headers as Record<string, string>)?.Cookie).includes("old-session")) return new Response("expired", { status: 401 });
      if (url.includes("user.status")) return Response.json({ result: { networks: [{ id: "net", name: "Chemistry", course_number: "CHMA10" }] } });
      if (url.includes("network.get_my_feed")) return Response.json({ result: { feed: [] } });
    }
    throw new Error("unexpected Piazza request");
  };
  try {
    await syncPiazza();
    assert.equal(logins, 1);
    assert.equal((await getPiazzaStatus()).status, "connected");
    assert.ok((await getPiazzaAutoLoginStatus()).lastSuccessAt);
    await syncPiazza();
    assert.equal(logins, 1);
    await deletePiazzaAutoLogin();
    await staleConnection();
    await assert.rejects(() => syncPiazza(), /PIAZZA_AUTO_LOGIN_NOT_CONFIGURED/);
    assert.equal(logins, 1);
  } finally { globalThis.fetch = original; }
});

test("rejected saved credentials are discarded instead of retried indefinitely", async () => {
  await staleConnection();
  await savePiazzaAutoLogin("student@example.com", "obsolete-password");
  let logins = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/main/csrf_token")) return new Response('csrf_token = "token"', { headers: { "Set-Cookie": "csrftoken=csrf" } });
    if (url.endsWith("/class")) { logins++; return new Response('var error_msg = "Invalid"'); }
    if (url.includes("/logic/api")) return new Response("expired", { status: 401 });
    throw new Error("unexpected Piazza request");
  };
  try {
    await assert.rejects(() => syncPiazza(), /PIAZZA_AUTH_FAILED/);
    assert.equal(logins, 1);
    assert.equal((await getPiazzaAutoLoginStatus()).enabled, false);
    await assert.rejects(() => syncPiazza(), /PIAZZA_AUTO_LOGIN_NOT_CONFIGURED/);
    assert.equal(logins, 1);
  } finally { globalThis.fetch = original; }
});
