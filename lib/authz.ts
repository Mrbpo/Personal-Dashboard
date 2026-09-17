import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

export type Owner = { userId: string; email: string; fullName: string };

function localOwner(): Owner {
  const configuredName = process.env.OWNER_NAME?.trim();
  const fullName = configuredName && !/^(your name|replace|name)$/i.test(configuredName) ? configuredName : "同学";
  return { userId: "local-owner", email: process.env.OWNER_EMAIL || "local@course-radar.test", fullName };
}

function sessionValue() {
  const secret = process.env.SESSION_SECRET || process.env.OWNER_ACCESS_KEY;
  return secret ? createHmac("sha256", secret).update("course-radar-owner").digest("hex") : null;
}

function same(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function getCurrentOwner(): Promise<Owner | null> {
  if (process.env.NODE_ENV !== "production" && process.env.LOCAL_DEV_BYPASS_AUTH !== "false") return localOwner();
  const requestHeaders = await headers();
  const bearer = requestHeaders.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && process.env.DASHBOARD_API_TOKEN && same(bearer, process.env.DASHBOARD_API_TOKEN)) return localOwner();
  const expected = sessionValue();
  const actual = (await cookies()).get("course_radar_session")?.value;
  return expected && actual && same(actual, expected) ? localOwner() : null;
}

export async function requireOwnerPage(returnTo: string) {
  void returnTo;
  const user = await getCurrentOwner();
  return { user: user ?? localOwner(), authorized: Boolean(user) };
}

export async function requireOwnerApi(): Promise<Response | null> {
  return await getCurrentOwner() ? null : Response.json({ error: "需要登录或有效 API Token" }, { status: 401 });
}

export function createOwnerSession() { return sessionValue(); }
export function verifyOwnerAccessKey(value: string) {
  return Boolean(process.env.OWNER_ACCESS_KEY && same(value, process.env.OWNER_ACCESS_KEY));
}
