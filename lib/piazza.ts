import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { textFromHtml } from "./canvas.ts";

export type PiazzaCookies = Record<string, string>;
export type PiazzaClass = { nid: string; name: string; num: string; term: string; courseId?: string; courseCode?: string };
const READ_ONLY_METHODS = new Set(["user.status", "network.get_my_feed", "content.get"]);

function encryptionKey() {
  const secret = process.env.SESSION_SECRET || process.env.OWNER_ACCESS_KEY;
  if (!secret) throw new Error("PIAZZA_ENCRYPTION_NOT_CONFIGURED");
  return createHash("sha256").update(secret).digest();
}

export function encryptPiazzaCookies(cookies: PiazzaCookies) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptPiazzaCookies(value: string): PiazzaCookies {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("PIAZZA_SESSION_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"));
}

function setCookies(response: Response, jar: PiazzaCookies) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  for (const value of values) {
    const match = value.match(/^([^=;,\s]+)=([^;]*)/);
    if (match) jar[match[1]] = match[2];
  }
}

function cookieHeader(cookies: PiazzaCookies) {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
}

function nonce() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
}

export async function piazzaRpc<T = any>(cookies: PiazzaCookies, method: string, params: Record<string, unknown> = {}, nid?: string): Promise<T> {
  if (!READ_ONLY_METHODS.has(method)) throw new Error("PIAZZA_WRITE_BLOCKED");
  const payload = { method, params: nid ? { nid, ...params } : params };
  const response = await fetch(`https://piazza.com/logic/api?method=${encodeURIComponent(method)}&aid=${nonce()}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { Cookie: cookieHeader(cookies), ...(cookies.session_id ? { "CSRF-Token": cookies.session_id } : {}) },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  setCookies(response, cookies);
  if (!response.ok) throw new Error(`PIAZZA_REQUEST_FAILED_${response.status}`);
  const result = await response.json().catch(() => { throw new Error("PIAZZA_SESSION_EXPIRED"); });
  if (result?.error) throw new Error("PIAZZA_REQUEST_REJECTED");
  return result?.result as T;
}

export async function loginPiazza(email: string, password: string) {
  const cookies: PiazzaCookies = {};
  const csrfResponse = await fetch("https://piazza.com/main/csrf_token", { redirect: "follow" });
  setCookies(csrfResponse, cookies);
  const csrfText = await csrfResponse.text();
  const token = csrfText.match(/csrf_token\s*=\s*["']([^"']+)/i)?.[1];
  if (!token) throw new Error("PIAZZA_CSRF_FAILED");
  const form = new URLSearchParams({ from: "/signup", email, password, remember: "on", csrf_token: token });
  const loginResponse = await fetch("https://piazza.com/class", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(cookies) }, body: form, redirect: "follow",
  });
  setCookies(loginResponse, cookies);
  const html = await loginResponse.text();
  if (!loginResponse.ok || /var\s+error_msg\s*=\s*["'][^"']+/i.test(html) || !cookies.session_id) throw new Error("PIAZZA_AUTH_FAILED");
  const status = await piazzaRpc<any>(cookies, "user.status");
  return { cookies, status };
}

export function classesFromStatus(status: any): PiazzaClass[] {
  return (Array.isArray(status?.networks) ? status.networks : []).map((item: any) => ({
    nid: String(item.id), name: String(item.name || item.course_number || "未命名课程"),
    num: String(item.course_number || ""), term: String(item.term || ""),
  }));
}

export function baseCourseCode(value: string) {
  return value.toUpperCase().replace(/\s+/g, "").match(/[A-Z]{2,}\d+/)?.[0] || "";
}

function nodeText(node: any): string {
  const current = Array.isArray(node?.history) ? node.history[0] : node;
  const own = [current?.content, node?.type === "followup" ? current?.subject : ""].filter(Boolean).join("\n");
  const children = Array.isArray(node?.children) ? node.children.map(nodeText).filter(Boolean).join("\n") : "";
  return textFromHtml([own, children].filter(Boolean).join("\n"));
}

export function normalizePiazzaPost(post: any, networkId: string, courseId: string) {
  const current = Array.isArray(post?.history) ? post.history[0] : post;
  const postNumber = String(post?.nr ?? post?.id ?? current?.id ?? "");
  const title = textFromHtml(current?.subject || post?.subject || `Piazza #${postNumber}`);
  const body = nodeText(post);
  const updatedAt = String(post?.modified || post?.updated || current?.created || "") || null;
  const folders = Array.isArray(post?.folders) ? post.folders.map(String) : [];
  const contentHash = createHash("sha256").update(JSON.stringify({ title, body, folders, updatedAt })).digest("hex");
  return { id: `piazza:${networkId}:${postNumber}`, courseId, networkId, postNumber, title, body, folders, updatedAt, contentHash, sourceUrl: `https://piazza.com/class/${networkId}/post/${postNumber}` };
}
