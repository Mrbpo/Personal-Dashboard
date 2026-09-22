import { baseCourseCode, classesFromStatus, decryptPiazzaCookies, encryptPiazzaCookies, normalizePiazzaPost, piazzaRpc, type PiazzaClass } from "./piazza.ts";
import { countPiazzaPosts, getIntegrationConnection, listCourseSettings, saveIntegrationConnection, savePiazzaPost, updateIntegrationStatus } from "./repository.ts";
import { getPiazzaDailySummary, piazzaDate, piazzaTimezone } from "./piazza-digest.ts";
import { database as db } from "./database.ts";

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
  if (!standalone.length) return;
  const now = new Date().toISOString();
  await db.batch(standalone.map(item => db.prepare(`INSERT INTO courses (id,name,code,term_name,enabled,updated_at)
    VALUES (?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,term_name=excluded.term_name,updated_at=excluded.updated_at`)
    .bind(item.courseId!, item.name, item.courseCode!, item.term, now)));
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAuthFailure(code: string) {
  return ["PIAZZA_SESSION_EXPIRED", "PIAZZA_REQUEST_REJECTED", "PIAZZA_AUTH_FAILED", "PIAZZA_REQUEST_FAILED_401", "PIAZZA_REQUEST_FAILED_403"].includes(code);
}

export async function getPiazzaStatus() {
  const connection = await getIntegrationConnection("piazza");
  if (!connection) return { connected: false, status: "disconnected", classes: [], lastSyncedAt: null, postCount: 0, error: null };
  return {
    connected: connection.status === "connected" || connection.status === "error",
    status: connection.status,
    classes: Array.isArray(connection.metadata.classes) ? connection.metadata.classes : [],
    lastSyncedAt: connection.lastSyncedAt,
    postCount: await countPiazzaPosts(),
    error: connection.error,
  };
}

export async function connectPiazza(email: string, password: string) {
  const { loginPiazza } = await import("./piazza.ts");
  const { cookies, status } = await loginPiazza(email, password);
  const classes = mapClasses(classesFromStatus(status), await listCourseSettings());
  await ensurePiazzaOnlyCourses(classes);
  await saveIntegrationConnection("piazza", encryptPiazzaCookies(cookies), { classes, postCount: 0 }, "connected");
  return { connected: true, status: "connected", classes, lastSyncedAt: null, postCount: 0, error: null };
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
  try {
    const status = await piazzaRpc<any>(cookies, "user.status");
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
        const feedResult = await piazzaRpc<any>(cookies, "network.get_my_feed", { limit: 30, offset, sort: "updated" }, item.nid);
        if (!Array.isArray(feedResult?.feed)) throw new Error("PIAZZA_FEED_INVALID");
        const feed: FeedItem[] = Array.isArray(feedResult?.feed) ? feedResult.feed : [];
        for (const feedItem of feed.slice(0, 30)) {
          const cid = String(feedItem.id ?? feedItem.cid ?? "");
          if (!cid || seen.has(cid)) continue;
          seen.add(cid);
          const fullPost = await piazzaRpc<any>(cookies, "content.get", { cid, student_view: null }, item.nid);
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
    await getPiazzaDailySummary(piazzaDate(new Date(), timezone), timezone);
    return { classes, imported, results, lastSyncedAt: new Date().toISOString() };
  } catch (error) {
    const code = error instanceof Error ? error.message : "PIAZZA_SYNC_FAILED";
    const authFailure = isAuthFailure(code);
    await updateIntegrationStatus("piazza", authFailure ? "needs_reconnect" : "error", authFailure ? "Piazza 登录已失效，请重新连接" : "Piazza 暂时无法同步");
    throw error;
  }
}
