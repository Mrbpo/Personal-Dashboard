import { serviceValue } from "./service-vault.ts";
import type { CanvasSource } from "./domain.ts";

type JsonObject = Record<string, any>;

function config() {
  const baseUrl = (process.env.CANVAS_BASE_URL || "https://q.utoronto.ca").replace(/\/$/, "");
  const token = serviceValue("CANVAS_TOKEN");
  if (!token) throw new Error("CANVAS_TOKEN_NOT_CONFIGURED");
  return { baseUrl, token };
}

async function canvasRequest<T>(pathOrUrl: string): Promise<{ data: T; headers: Headers; status: number }> {
  const { baseUrl, token } = config();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : baseUrl + pathOrUrl;
  if (!url.startsWith(baseUrl + "/")) throw new Error("UNTRUSTED_CANVAS_URL");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2500, retryAfter ? retryAfter * 1000 : 350 * 2 ** attempt)));
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error("CANVAS_AUTH_FAILED");
      throw new Error("CANVAS_REQUEST_FAILED_" + response.status);
    }
    return { data: await response.json() as T, headers: response.headers, status: response.status };
  }
  throw new Error("CANVAS_RATE_LIMITED");
}

async function canvasMutation<T>(path: string, method: "POST" | "PUT", values: Record<string, string>) {
  const { baseUrl, token } = config();
  const response = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("CANVAS_AUTH_FAILED");
    if (response.status === 403) throw new Error("CANVAS_PLANNER_WRITE_FORBIDDEN");
    throw new Error("CANVAS_PLANNER_WRITE_FAILED_" + response.status);
  }
  return await response.json() as T;
}

export async function setCanvasPlannerComplete(sourceType: string, sourceId: string, completed: boolean) {
  const typeMap: Record<string, string> = { announcement: "announcement", assignment: "assignment", discussion: "discussion_topic", quiz: "quiz", page: "wiki_page" };
  const plannableType = typeMap[sourceType];
  if (!plannableType || !/^\d+$/.test(sourceId)) return { supported: false, synced: false };
  const overrides = await allPages<JsonObject>("/api/v1/planner/overrides?per_page=100");
  const existing = overrides.find((item) => String(item.plannable_id) === sourceId && String(item.plannable_type).toLowerCase() === plannableType);
  if (existing) {
    await canvasMutation(`/api/v1/planner/overrides/${existing.id}`, "PUT", { marked_complete: String(completed) });
    return { supported: true, synced: true };
  }
  if (!completed) return { supported: true, synced: true };
  await canvasMutation("/api/v1/planner/overrides", "POST", { plannable_type: plannableType, plannable_id: sourceId, marked_complete: "true" });
  return { supported: true, synced: true };
}

export function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

export async function allPages<T>(path: string): Promise<T[]> {
  let next: string | null = path;
  const items: T[] = [];
  while (next) {
    const result = await canvasRequest<T[]>(next);
    items.push(...result.data);
    next = nextLink(result.headers.get("link"));
  }
  return items;
}

export function textFromHtml(html: string | null | undefined): string {
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
    prerequisiteBlocked: Boolean(item.locked_for_user),
    moduleName: item.module_name ?? null,
    folderPath: item.folder_path ?? null,
    file: null,
  };
}

export function plannerSourceFromItem(courseId: string, item: JsonObject): CanvasSource {
  const source = sourceFromObject(courseId, "planner", item.plannable ?? item);
  source.plannableType = item.plannable_type == null ? null : String(item.plannable_type);
  source.plannableId = item.plannable_id == null ? null : String(item.plannable_id);
  source.plannerItemId = item.id == null ? null : String(item.id);
  source.plannerContextCode = item.context_code == null ? null : String(item.context_code);
  source.plannerCourseId = item.course_id == null ? null : String(item.course_id);
  source.sourceUrl ??= item.html_url ?? null;
  source.updatedAt ??= item.updated_at ?? null;
  source.dueAt ??= item.plannable_date ?? null;
  return source;
}

/** A historical window must be complete before callers ingest any of its items. */
export async function getHistoricalPlannerSources(courseId: string, start: string, end: string,
  targetSourceIds?: ReadonlySet<string>): Promise<CanvasSource[]> {
  if (!/^[1-9]\d*$/.test(courseId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end ||
    (Date.parse(end) - Date.parse(start)) / 86400000 > 14)
    throw new Error('INVALID_PLANNER_WINDOW');
  let next: string | null = `/api/v1/planner/items?context_codes[]=${encodeURIComponent(`course_${courseId}`)}` +
    `&start_date=${start}&end_date=${end}&per_page=100`;
  const visited = new Set<string>();
  const items: JsonObject[] = [];
  while (next) {
    if (visited.has(next) || visited.size >= 20) throw new Error('CANVAS_PLANNER_PAGE_LIMIT');
    visited.add(next);
    const page = await canvasRequest<JsonObject[]>(next);
    if (page.status !== 200 || !Array.isArray(page.data)) throw new Error('CANVAS_PARTIAL_PLANNER_WINDOW');
    items.push(...page.data);
    if (items.length > 2000) throw new Error('CANVAS_PLANNER_ITEM_LIMIT');
    next = nextLink(page.headers.get('link'));
  }
  return items.map(item => {
    const source = plannerSourceFromItem(courseId, item);
    if (targetSourceIds && !targetSourceIds.has(source.id)) return null;
    // Canvas's scoped query is insufficient if an item carries contradictory course metadata.
    const context = item.context_code == null ? null : String(item.context_code);
    const nestedCourse = item.plannable?.course_id ?? item.course_id;
    const course = nestedCourse == null ? null : String(nestedCourse);
    if ((context && context !== `course_${courseId}`) || (course && course !== courseId))
      throw new Error('CANVAS_PLANNER_COURSE_MISMATCH');
    if (!context && !course) throw new Error('CANVAS_PLANNER_COURSE_UNVERIFIED');
    if (!/^[1-9]\d*$/.test(source.sourceId)) throw new Error('CANVAS_PLANNER_ID_UNVERIFIED');
    return source;
  }).filter((source): source is CanvasSource => source !== null);
}

function canvasFolderPath(folder: JsonObject | undefined) {
  const full = String(folder?.full_name || folder?.name || "").replaceAll("\\", "/");
  const parts = full.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length && /^(course files|files|课程文件)$/i.test(parts[0])) parts.shift();
  return ["Canvas 文件", ...parts].join("/");
}

export async function listActiveCourses() {
  return allPages<JsonObject>("/api/v1/courses?enrollment_state=active&include[]=term&per_page=100");
}

export async function getCourseSources(courseId: string): Promise<{ sources: CanvasSource[]; assignments: JsonObject[]; complete: boolean }> {
  const { baseUrl } = config();
  let complete=true;
  const optional=<T>(request:Promise<T>,fallback:T)=>request.catch(()=>{complete=false;return fallback;});
  const now = new Date();
  const start = new Date(now.getTime() - 120 * 86400000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 180 * 86400000).toISOString().slice(0, 10);
  const encodedContext = encodeURIComponent("course_" + courseId);

  const [announcements, assignments, modules, quizzes, discussions, pageIndex, courseFiles, courseFolders, planner, courseDetail] = await Promise.all([
    allPages<JsonObject>("/api/v1/announcements?context_codes[]=" + encodedContext + "&start_date=" + start + "&end_date=" + end + "&per_page=100"),
    allPages<JsonObject>("/api/v1/courses/" + courseId + "/assignments?include[]=submission&include[]=all_dates&order_by=due_at&per_page=100"),
    allPages<JsonObject>("/api/v1/courses/" + courseId + "/modules?include[]=items&include[]=content_details&per_page=100"),
    optional(allPages<JsonObject>("/api/v1/courses/" + courseId + "/quizzes?per_page=100"),[]),
    optional(allPages<JsonObject>("/api/v1/courses/" + courseId + "/discussion_topics?per_page=100"),[]),
    optional(allPages<JsonObject>("/api/v1/courses/" + courseId + "/pages?per_page=100"),[]),
    optional(allPages<JsonObject>("/api/v1/courses/" + courseId + "/files?per_page=100"),[]),
    optional(allPages<JsonObject>("/api/v1/courses/" + courseId + "/folders?per_page=100"),[]),
    optional(allPages<JsonObject>("/api/v1/planner/items?context_codes[]=" + encodedContext + "&start_date=" + start + "&end_date=" + end + "&per_page=100"),[]),
    optional(canvasRequest<JsonObject>("/api/v1/courses/" + courseId + "?include[]=syllabus_body&include[]=term").then((result) => result.data),{}),
  ]);
  const foldersById = new Map(courseFolders.map((folder) => [String(folder.id), folder]));
  const pages = await Promise.all(pageIndex.map((page) => canvasRequest<JsonObject>("/api/v1/courses/" + courseId + "/pages/" + encodeURIComponent(page.url)).then((result) => result.data).catch(() => { complete=false; return page; })));
  const plannerCompletion = new Map(planner.map((item) => [`${String(item.plannable_type || "").toLowerCase()}:${String(item.plannable_id ?? item.plannable?.id ?? "")}`, Boolean(item.planner_override?.marked_complete)]));

  const canvasSource = (type: string, item: JsonObject) => {
    const source = sourceFromObject(courseId, type, item);
    const plannerType = type === "discussion" ? "discussion_topic" : type === "page" ? "wiki_page" : type;
    if (plannerCompletion.get(`${plannerType}:${source.sourceId}`)) source.submissionState = "completed";
    return source;
  };

  const sources = [
    ...announcements.map((item) => canvasSource("announcement", item)),
    ...assignments.map((item) => canvasSource("assignment", item)),
    ...quizzes.map((item) => canvasSource("quiz", item)),
    ...discussions.map((item) => canvasSource("discussion", item)),
    ...pages.map((item) => canvasSource("page", item)),
    ...courseFiles.map((item) => {
      const source = sourceFromObject(courseId, "file", item);
      source.folderPath = canvasFolderPath(foldersById.get(String(item.folder_id)));
      source.file = { url: item.url ?? "", name: item.display_name ?? item.filename ?? "file", size: Number(item.size ?? 0), contentType: item["content-type"] ?? item.content_type ?? "application/octet-stream" };
      return source;
    }),
    ...planner.map((item) => plannerSourceFromItem(courseId, item)),
  ];
  const syllabusBody = textFromHtml(courseDetail.syllabus_body);
  if (syllabusBody) sources.push(sourceFromObject(courseId, "syllabus", { id: courseId, title: "课程大纲 Syllabus", body: syllabusBody, html_url: baseUrl + "/courses/" + courseId + "/assignments/syllabus", updated_at: courseDetail.updated_at, folder_path: "课程大纲" }));
  for (const courseModule of modules) {
    const source = sourceFromObject(courseId, "module", {
      id: courseModule.id,
      name: courseModule.name,
      body: [courseModule.state ? "Module 状态：" + courseModule.state : "", courseModule.completed_at ? "完成时间：" + courseModule.completed_at : "", courseModule.prerequisite_module_ids?.length ? "先修 Module ID：" + courseModule.prerequisite_module_ids.join(", ") : ""].filter(Boolean).join("\n"),
      html_url: baseUrl + "/courses/" + courseId + "/modules",
      updated_at: courseModule.updated_at,
    });
    sources.push(source);
  }
  const seen = new Set(sources.map((source) => source.id));

  for (const courseModule of modules) {
    const items = Array.isArray(courseModule.items)
      ? courseModule.items
      : await allPages<JsonObject>("/api/v1/courses/" + courseId + "/modules/" + courseModule.id + "/items?include[]=content_details&per_page=100");
    for (const item of items) {
      const type = String(item.type || "module_item").toLowerCase();
      let detail = item;
      if (item.url && typeof item.url === "string" && item.url.startsWith(baseUrl + "/api/")) {
        detail = await canvasRequest<JsonObject>(item.url).then((result) => result.data).catch(() => { complete=false; return item; });
      }
      const source = sourceFromObject(courseId, type, { ...(item.content_details || {}), ...detail, title: item.title ?? detail.title, html_url: item.html_url ?? detail.html_url, locked_for_user: item.locked_for_user, module_name: courseModule.name });
      const moduleContext = [
        courseModule.name ? "所属 Module：" + courseModule.name : "",
        item.completion_requirement ? "完成要求：" + JSON.stringify(item.completion_requirement) : "",
        courseModule.prerequisite_module_ids?.length ? "先修 Module ID：" + courseModule.prerequisite_module_ids.join(", ") : "",
        item.locked_for_user ? "当前状态：因先修条件尚未满足而锁定" : "",
      ].filter(Boolean).join("\n");
      if (moduleContext) source.body = moduleContext + (source.body ? "\n" + source.body : "");
      source.prerequisiteBlocked = Boolean(item.locked_for_user);
      source.moduleName = courseModule.name ?? null;
      if (type === "file") {
        source.folderPath = courseModule.name ? `Modules/${courseModule.name}` : canvasFolderPath(foldersById.get(String(detail.folder_id)));
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
      } else if (type === "file") {
        const existing = sources.find((candidate) => candidate.id === source.id);
        if (existing) {
          existing.moduleName = existing.moduleName || courseModule.name || null;
          existing.folderPath = source.folderPath || existing.folderPath;
          if (moduleContext && !existing.body.includes(moduleContext)) existing.body = moduleContext + (existing.body ? "\n" + existing.body : "");
        }
      }
    }
  }
  for (const parent of [...announcements, ...assignments]) {
    for (const attachment of parent.attachments || []) {
      const source = sourceFromObject(courseId, "file", { ...attachment, title: attachment.display_name ?? attachment.filename, html_url: parent.html_url });
      source.folderPath = parent.name || parent.title ? `附件/${parent.name || parent.title}` : "附件";
      source.file = { url: attachment.url ?? "", name: attachment.display_name ?? attachment.filename ?? "file", size: Number(attachment.size ?? 0), contentType: attachment["content-type"] ?? attachment.content_type ?? "application/octet-stream" };
      if (!seen.has(source.id)) { seen.add(source.id); sources.push(source); }
    }
  }
  return { sources, assignments, complete };
}

export async function downloadCanvasFile(url: string): Promise<Response> {
  const { baseUrl, token } = config();
  const parsed = new URL(url, baseUrl + "/");
  if (parsed.protocol !== "https:") throw new Error("UNTRUSTED_CANVAS_FILE_URL");
  if (parsed.origin !== new URL(baseUrl).origin) throw new Error("UNTRUSTED_CANVAS_FILE_URL");
  const response = await fetch(parsed, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("CANVAS_FILE_DOWNLOAD_FAILED_" + response.status);
  return response;
}
