import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const env = { ...process.env };
const configured = env.CANVAS_ENV_FILE;
const defaultFile = resolve(process.cwd(), "..", "QuercusModuleDownloader", ".env");
const envFile = configured || defaultFile;

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

env.DATABASE_URL ||= "file:./data/course-radar-v2.db";
env.LOCAL_DEV_BYPASS_AUTH ||= "true";
env.AUTO_SYNC_ENABLED ||= "true";
env.AUTO_SYNC_INTERVAL_MINUTES ||= "15";
env.PIAZZA_SYNC_INTERVAL_MINUTES ||= "30";

const forwardedArgs = process.argv.slice(2);
const portFlag = forwardedArgs.findIndex((arg) => arg === "-p" || arg === "--port");
const port = portFlag >= 0 ? forwardedArgs[portFlag + 1] : (env.PORT || "3000");
const localOrigin = `http://127.0.0.1:${port}`;
const intervalMinutes = Math.max(1, Number(env.AUTO_SYNC_INTERVAL_MINUTES) || 15);
let syncInProgress = false;
let piazzaSyncInProgress = false;

function torontoDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: env.TIMEZONE || "America/Toronto" });
}

async function runAutomaticSync() {
  if (syncInProgress) return;
  syncInProgress = true;
  const startedAt = new Date();
  try {
    const startResponse = await fetch(`${localOrigin}/api/sync`, { method: "POST" });
    const start = await startResponse.json();
    if (!startResponse.ok) throw new Error(start.error || `HTTP ${startResponse.status}`);
    let failed = 0;
    for (const course of start.courses || []) {
      const response = await fetch(`${localOrigin}/api/sync/courses/${encodeURIComponent(course.id)}?runId=${encodeURIComponent(start.runId)}&mode=automatic`, { method: "POST" });
      if (!response.ok) failed += 1;
    }
    await fetch(`${localOrigin}/api/plans/${torontoDate()}/generate`, { method: "POST" });
    const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    console.log(`[auto-sync] 完成：${(start.courses || []).length - failed}/${(start.courses || []).length} 门课程，耗时 ${seconds}s`);
  } catch (error) {
    console.warn(`[auto-sync] 本轮失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    syncInProgress = false;
  }
}

async function runPiazzaSync() {
  if (piazzaSyncInProgress) return;
  piazzaSyncInProgress = true;
  try {
    const statusResponse = await fetch(`${localOrigin}/api/piazza/status`);
    if (!statusResponse.ok) return;
    const status = await statusResponse.json();
    if (!status.connected && !status.autoLoginEnabled) return;
    const response = await fetch(`${localOrigin}/api/piazza/sync`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    console.log(`[piazza-sync] 完成：读取 ${result.imported || 0} 条最近帖子`);
  } catch (error) {
    console.warn(`[piazza-sync] 本轮失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    piazzaSyncInProgress = false;
  }
}

const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", ...process.argv.slice(2)], { env, stdio: "inherit" });
let initialTimer;
let intervalTimer;
let piazzaInitialTimer;
let piazzaIntervalTimer;
if (env.AUTO_SYNC_ENABLED !== "false") {
  initialTimer = setTimeout(() => void runAutomaticSync(), 20_000);
  intervalTimer = setInterval(() => void runAutomaticSync(), intervalMinutes * 60_000);
  console.log(`[auto-sync] 已启用，每 ${intervalMinutes} 分钟同步一次`);
}
const piazzaIntervalMinutes = Math.max(5, Number(env.PIAZZA_SYNC_INTERVAL_MINUTES) || 30);
piazzaInitialTimer = setTimeout(() => void runPiazzaSync(), 60_000);
piazzaIntervalTimer = setInterval(() => void runPiazzaSync(), piazzaIntervalMinutes * 60_000);
console.log(`[piazza-sync] 已启用，连接后每 ${piazzaIntervalMinutes} 分钟同步一次`);
child.on("exit", (code, signal) => {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  if (piazzaInitialTimer) clearTimeout(piazzaInitialTimer);
  if (piazzaIntervalTimer) clearInterval(piazzaIntervalTimer);
  process.exitCode = signal ? 1 : (code ?? 0);
});
