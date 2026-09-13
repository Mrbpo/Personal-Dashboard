import { env } from "cloudflare:workers";
import type { CanvasSource } from "./domain";

type JsonObject = Record<string, any>;

function config() {
  const baseUrl = (env.CANVAS_BASE_URL || "https://q.utoronto.ca").replace(/\/$/, "");
  const token = env.CANVAS_TOKEN;
  if (!token) throw new Error("CANVAS_TOKEN_NOT_CONFIGURED");
  return { baseUrl, token };
}

async function canvasRequest<T>(pathOrUrl: string): Promise<{ data: T; headers: Headers }> {
  const { baseUrl, token } = config();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : baseUrl + pathOrUrl;
  if (!url.startsWith(baseUrl + "/")) throw new Error("UNTRUSTED_CANVAS_URL");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (response.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error("CANVAS_AUTH_FAILED");
      throw new Error("CANVAS_REQUEST_FAILED_" + response.status);
    }
    return { data: await response.json() as T, headers: response.headers };
  }
  throw new Error("CANVAS_RATE_LIMITED");
}

function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

async function allPages<T>(path: string): Promise<T[]> {
  let next: string | null = path;
  const items: T[] = [];
  while (next) {
    const result = await canvasRequest<T[]>(next);
    items.push(...result.data);
    next = nextLink(result.headers.get("link"));
  }
  return items;
}

function textFromHtml(html: string | null | undefined): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function sourceFromObject(courseId: string, type: string, item: JsonObject): CanvasSource {
  const sourceId = String(item.id ?? item.page_id ?? item.url ?? crypto.randomUUID());
  const body = item.description ?? item.message ?? item.body ?? item.details ?? "";
  return {
    id: courseId + ":" + type + ":" + sourceId,
    courseId,
    sourceType: type,
    sourceId,
    title: item.name ?? item.title ?? item.display_name ?? type,
    body: textFromHtml(body),
    sourceUrl: item.html_url ?? item.url ?? null,
    updatedAt: item.updated_at ?? item.posted_at ?? item.created_at ?? null,
    dueAt: item.due_at ?? item.plannable_date ?? item.todo_date ?? null,
    unlockAt: item.unlock_at ?? null,
    lockAt: item.lock_at ?? null,
    submissionState: item.submission?.workflow_state ?? null,
    submittedAt: item.submission?.submitted_at ?? null,
    pointsPossible: typeof item.points_possible === "number" ? item.points_possible : null,
    file: null,
  };
}

export async function listActiveCourses() {
  return allPages<JsonObject>("/api/v1/courses?enrollment_state=active&include[]=term&per_page=100");
}

export async function getCourseSources(courseId: string): Promise<{ sources: CanvasSource[]; assignments: JsonObject[] }> {
  const { baseUrl } = config();
  const now = new Date();
  const start = new Date(now.getTime() - 120 * 86400000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 180 * 86400000).toISOString().slice(0, 10);
  const encodedContext = encodeURIComponent("course_" + courseId);

  const [announcements, assignments, modules, planner] = await Promise.all([
    allPages<JsonObject>("/api/v1/announcements?context_codes[]=" + encodedContext + "&start_date=" + start + "&end_date=" + end + "&per_page=100"),
    allPages<JsonObject>("/api/v1/courses/" + courseId + "/assignments?include[]=submission&include[]=all_dates&order_by=due_at&per_page=100"),
    allPages<JsonObject>("/api/v1/courses/" + courseId + "/modules?include[]=items&include[]=content_details&per_page=100"),
    allPages<JsonObject>("/api/v1/planner/items?context_codes[]=" + encodedContext + "&start_date=" + start + "&end_date=" + end + "&per_page=100").catch(() => []),
  ]);

  const sources = [
    ...announcements.map((item) => sourceFromObject(courseId, "announcement", item)),
    ...assignments.map((item) => sourceFromObject(courseId, "assignment", item)),
    ...planner.map((item) => sourceFromObject(courseId, "planner", item.plannable ?? item)),
  ];
  const seen = new Set(sources.map((source) => source.id));

  for (const courseModule of modules) {
    const items = Array.isArray(courseModule.items)
      ? courseModule.items
      : await allPages<JsonObject>("/api/v1/courses/" + courseId + "/modules/" + courseModule.id + "/items?include[]=content_details&per_page=100");
    for (const item of items) {
      const type = String(item.type || "module_item").toLowerCase();
      let detail = item;
      if (item.url && typeof item.url === "string" && item.url.startsWith(baseUrl + "/api/")) {
        detail = await canvasRequest<JsonObject>(item.url).then((result) => result.data).catch(() => item);
      }
      const source = sourceFromObject(courseId, type, { ...detail, title: item.title ?? detail.title, html_url: item.html_url ?? detail.html_url });
      if (type === "file") {
        source.file = {
          url: detail.url ?? "",
          name: detail.display_name ?? detail.filename ?? item.title ?? "file",
          size: Number(detail.size ?? 0),
          contentType: detail["content-type"] ?? detail.content_type ?? "application/octet-stream",
        };
      }
      if (!seen.has(source.id)) {
        seen.add(source.id);
        sources.push(source);
      }
    }
  }
  return { sources, assignments };
}

export async function downloadCanvasFile(url: string): Promise<Response> {
  const { baseUrl, token } = config();
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("UNTRUSTED_CANVAS_FILE_URL");
  const isCanvasUrl = url.startsWith(baseUrl + "/");
  // Canvas metadata can return a short-lived signed CDN URL. Never forward the
  // Canvas bearer token outside the configured Canvas origin.
  const response = await fetch(url, isCanvasUrl ? { headers: { Authorization: "Bearer " + token } } : undefined);
  if (!response.ok) throw new Error("CANVAS_FILE_DOWNLOAD_FAILED_" + response.status);
  return response;
}
