import { baseCourseCode, classesFromStatus, decryptPiazzaCookies, encryptPiazzaCookies, loginPiazza, normalizePiazzaPost, piazzaRpc, type PiazzaClass } from "./piazza.ts";
import { countPiazzaPosts, getIntegrationConnection, listCourseSettings, saveIntegrationConnection, savePiazzaPost, updateIntegrationStatus } from "./repository.ts";
import { getPiazzaDailySummary, piazzaDate, piazzaTimezone } from "./piazza-digest.ts";
import { acquireLease, enqueue, releaseLease } from "./jobs.ts";
import { piazzaWeekStart } from "./piazza-ai.ts";
import { serviceValue } from "./service-vault.ts";
import { deletePiazzaAutoLogin, getPiazzaAutoLogin, getPiazzaAutoLoginStatus, markPiazzaAutoLoginAttempt, markPiazzaAutoLoginResult, savePiazzaAutoLogin } from "./piazza-auto-login.ts";
import {kernel} from './kernel/service.ts';

type FeedItem = { id?: string | number; cid?: string | number; nr?: string | number; modified?: string; updated?: string };

function mapClasses(classes: PiazzaClass[], courses: Awaited<ReturnType<typeof listCourseSettings>>) {
  return classes.map((item) => {
    const code = baseCourseCode(`${item.num} ${item.name}`);
    const match = code ? courses.find((course) => course.enabled && baseCourseCode(course.code) === code) : undefined;
    return { ...item, courseId: match?.id || `piazza:${item.nid}`, courseCode: match?.code || item.num || item.name };
  });
}

async function ensurePiazzaOnlyCourses(classes: ReturnType<typeof mapClasses>) {
  const standalone = classes.filter(item => item.courseId?.startsWith("piazza:"));
  for(const item of standalone)await kernel.upsertCourse({id:item.courseId,name:item.name,code:item.courseCode,term_name:item.term,enabled:false},'piazza');
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAuthFailure(code: string) {
  return ["PIAZZA_SESSION_EXPIRED", "PIAZZA_REQUEST_REJECTED", "PIAZZA_AUTH_FAILED", "PIAZZA_REQUEST_FAILED_401", "PIAZZA_REQUEST_FAILED_403"].includes(code);
}

export async function getPiazzaStatus() {
  const connection = await getIntegrationConnection("piazza");
  const auto = await getPiazzaAutoLoginStatus();
  if (!connection) return { connected: false, status: "disconnected", classes: [], lastSyncedAt: null, postCount: 0, error: null, autoLoginEnabled: false, lastAutoLoginAt: null, autoLoginError: null };
  return {
    connected: connection.status === "connected" || connection.status === "error",
    status: connection.status,
    classes: Array.isArray(connection.metadata.classes) ? connection.metadata.classes : [],
    lastSyncedAt: connection.lastSyncedAt,
    postCount: await countPiazzaPosts(),
    error: connection.error,
    autoLoginEnabled: auto.enabled,
    lastAutoLoginAt: auto.lastSuccessAt,
    autoLoginError: auto.error,
  };
}

export async function connectPiazza(email: string, password: string, autoLogin = false) {
  const { cookies, status } = await loginPiazza(email, password);
  const classes = mapClasses(classesFromStatus(status), await listCourseSettings());
  await ensurePiazzaOnlyCourses(classes);
  const previous = await getIntegrationConnection("piazza");
  const archiveOffsets = Object.fromEntries(Object.entries(previous?.metadata.archiveOffsets || {}).filter(([nid]) => classes.some(item => item.nid === nid)));
  const postCount = await countPiazzaPosts();
  await saveIntegrationConnection("piazza", encryptPiazzaCookies(cookies), { classes, postCount, archiveOffsets }, "connected");
  if (autoLogin) await savePiazzaAutoLogin(email, password);
  else await deletePiazzaAutoLogin();
  return { connected: true, status: "connected", classes, lastSyncedAt: previous?.lastSyncedAt || null,
    postCount, error: null, autoLoginEnabled: autoLogin, lastAutoLoginAt: null, autoLoginError: null };
}

async function refreshPiazzaSession(cookies: Record<string, string>, metadata: Record<string, unknown>) {
  const credentials = await getPiazzaAutoLogin();
  if (!credentials) throw new Error("PIAZZA_AUTO_LOGIN_NOT_CONFIGURED");
  if (credentials.lastAttemptAt && Date.now() - new Date(credentials.lastAttemptAt).getTime() < 15 * 60_000)
    throw new Error("PIAZZA_AUTO_LOGIN_COOLDOWN");
  const token = crypto.randomUUID();
  if (!await acquireLease("piazza-auto-login", token, Date.now(), 120_000)) throw new Error("PIAZZA_AUTO_LOGIN_BUSY");
  try {
    await markPiazzaAutoLoginAttempt();
    try {
      const refreshed = await loginPiazza(credentials.email, credentials.password);
      for (const name of Object.keys(cookies)) delete cookies[name];
      Object.assign(cookies, refreshed.cookies);
      await saveIntegrationConnection("piazza", encryptPiazzaCookies(cookies), metadata, "connected");
      await markPiazzaAutoLoginResult(true);
    } catch (error) {
      await markPiazzaAutoLoginResult(false);
      if (error instanceof Error && error.message === "PIAZZA_AUTH_FAILED") await deletePiazzaAutoLogin();
      throw error;
    }
  } finally { await releaseLease("piazza-auto-login", token); }
}

let activeSync: Promise<unknown> | null = null;
export function syncPiazza() {
  if (!activeSync) activeSync = runSyncPiazza().finally(() => { activeSync = null; });
  return activeSync;
}

async function runSyncPiazza() {
  const connection = await getIntegrationConnection("piazza");
  if (!connection) throw new Error("PIAZZA_NOT_CONNECTED");
  const cookies = decryptPiazzaCookies(connection.encryptedSecret);
  let reloginAttempted = false;
  async function rpc<T = any>(method: string, params: Record<string, unknown> = {}, nid?: string): Promise<T> {
    try { return await piazzaRpc<T>(cookies, method, params, nid); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!isAuthFailure(code) || reloginAttempted) throw error;
      reloginAttempted = true;
      await refreshPiazzaSession(cookies, connection!.metadata);
      return piazzaRpc<T>(cookies, method, params, nid);
    }
  }
  try {
    const status = await rpc<any>("user.status");
    const classes = mapClasses(classesFromStatus(status), await listCourseSettings());
    await ensurePiazzaOnlyCourses(classes);
    let imported = 0;
    const archiveOffsets: Record<string, number> = { ...(connection.metadata.archiveOffsets || {}) };
    const results: Array<{ nid: string; courseCode?: string; imported: number; error?: string }> = [];

    for (const item of classes) {
      let courseImported = 0;
      try {
        const seen = new Set<string>();
        // Refresh the newest page, then progressively backfill older pages across runs.
        const olderOffset = Math.max(30, Number(archiveOffsets[item.nid]) || 30);
        for (const offset of [0, olderOffset, olderOffset + 30]) {
        const feedResult = await rpc<any>("network.get_my_feed", { limit: 30, offset, sort: "updated" }, item.nid);
        if (!Array.isArray(feedResult?.feed)) throw new Error("PIAZZA_FEED_INVALID");
        const feed: FeedItem[] = Array.isArray(feedResult?.feed) ? feedResult.feed : [];
        for (const feedItem of feed.slice(0, 30)) {
          const cid = String(feedItem.id ?? feedItem.cid ?? "");
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const fullPost = await rpc<any>("content.get", { cid, student_view: null }, item.nid);
          const normalized = normalizePiazzaPost(fullPost, item.nid, item.courseId!);
          if (!normalized.postNumber) continue;
          await savePiazzaPost(normalized);
          imported += 1;
          courseImported += 1;
          await sleep(350);
        }
        archiveOffsets[item.nid] = offset + 30;
        if (feed.length < 30) { archiveOffsets[item.nid] = 30; break; }
        }
        results.push({ nid: item.nid, courseCode: item.courseCode, imported: courseImported });
      } catch (error) {
        const code = error instanceof Error ? error.message : "PIAZZA_SYNC_FAILED";
        if (isAuthFailure(code)) throw error;
        results.push({ nid: item.nid, courseCode: item.courseCode, imported: courseImported, error: "这门 Piazza 课程暂时无法读取" });
      }
    }

    const metadata = { classes, postCount: await countPiazzaPosts(), archiveOffsets, lastResults: results };
    await saveIntegrationConnection("piazza", encryptPiazzaCookies(cookies), metadata, "connected");
    await updateIntegrationStatus("piazza", "connected", null, metadata);
    const timezone = await piazzaTimezone();
    const today = piazzaDate(new Date(), timezone);
    await getPiazzaDailySummary(today, timezone);
    if (serviceValue("OPENAI_API_KEY")) {
      const start = piazzaWeekStart(today);
      await enqueue("piazza-ai-week", { weekStart: start }, `piazza-ai-week:${start}`, true);
    }
    return { classes, imported, results, lastSyncedAt: new Date().toISOString() };
  } catch (error) {
    const code = error instanceof Error ? error.message : "PIAZZA_SYNC_FAILED";
    const authFailure = reloginAttempted || isAuthFailure(code) || code.startsWith("PIAZZA_AUTO_LOGIN_");
    await updateIntegrationStatus("piazza", authFailure ? "needs_reconnect" : "error", authFailure ? "Piazza 会话失效；自动重登未成功，请检查设置" : "Piazza 暂时无法同步");
    throw error;
  }
}
