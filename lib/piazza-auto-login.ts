import { database as db } from "./database.ts";
import { seal, unseal } from "./service-vault.ts";

type Credentials = { email: string; password: string };

export async function savePiazzaAutoLogin(email: string, password: string) {
  const encrypted = seal({ email, password } satisfies Credentials);
  await db.prepare(`INSERT INTO piazza_auto_login (id,credentials_encrypted,last_attempt_at,last_success_at,last_error)
    VALUES (1,?,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET credentials_encrypted=excluded.credentials_encrypted,
    last_attempt_at=NULL,last_success_at=NULL,last_error=NULL`).bind(encrypted).run();
}

export async function getPiazzaAutoLogin() {
  const row = await db.prepare("SELECT credentials_encrypted,last_attempt_at FROM piazza_auto_login WHERE id=1")
    .first<{ credentials_encrypted: string; last_attempt_at: string | null }>();
  if (!row) return null;
  let credentials: Credentials;
  try { credentials = unseal<Credentials>(row.credentials_encrypted); }
  catch { await deletePiazzaAutoLogin(); throw new Error("PIAZZA_AUTO_LOGIN_INVALID"); }
  if (!credentials.email || !credentials.password) throw new Error("PIAZZA_AUTO_LOGIN_INVALID");
  return { ...credentials, lastAttemptAt: row.last_attempt_at };
}

export async function getPiazzaAutoLoginStatus() {
  const row = await db.prepare("SELECT last_attempt_at,last_success_at,last_error FROM piazza_auto_login WHERE id=1")
    .first<{ last_attempt_at: string | null; last_success_at: string | null; last_error: string | null }>();
  return { enabled: Boolean(row), lastAttemptAt: row?.last_attempt_at || null,
    lastSuccessAt: row?.last_success_at || null, error: row?.last_error || null };
}

export async function markPiazzaAutoLoginAttempt() {
  await db.prepare("UPDATE piazza_auto_login SET last_attempt_at=?,last_error=NULL WHERE id=1")
    .bind(new Date().toISOString()).run();
}

export async function markPiazzaAutoLoginResult(success: boolean) {
  await db.prepare("UPDATE piazza_auto_login SET last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,last_error=? WHERE id=1")
    .bind(success ? 1 : 0, new Date().toISOString(), success ? null : "自动重登失败，请检查 Piazza 登录").run();
}

export async function deletePiazzaAutoLogin() {
  await db.prepare("DELETE FROM piazza_auto_login WHERE id=1").run();
}
