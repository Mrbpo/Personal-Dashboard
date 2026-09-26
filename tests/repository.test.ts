import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasSource, ExtractedAnalysis } from "../lib/domain.ts";

process.env.DATABASE_URL = ":memory:";
const repo = await import("../lib/repository.ts");

test("Piazza summaries isolate course and source; archives retain changed versions", async () => {
  await repo.upsertCourses([{ id: "chem", name: "Chemistry", course_code: "CHMA10H3" }, { id: "stats", name: "Statistics", course_code: "STAB22H3" }]);
  const post = { id: "piazza:test:1", courseId: "chem", networkId: "test", postNumber: "1", title: "Lab safety", body: "Bring goggles", answer: "", kind: "note", createdAt: "2026-09-14", sourceUrl: "https://piazza.com/class/test/post/1", folders: [], updatedAt: "2026-09-14", contentHash: "a" };
  await repo.savePiazzaPost(post);
  await repo.savePiazzaPost(post);
  await repo.savePiazzaPost({ ...post, body: "Bring goggles and gloves", contentHash: "b" });
  await repo.savePiazzaPost({ ...post, id: "piazza:stats:1", courseId: "stats", networkId: "stats", title: "Welcome to Piazza" });
  const sources = await repo.searchCourseContent("帮我总结一下CHMA10 piazza", undefined, 100);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].courseId, "chem");
  assert.equal(sources[0].sourceType, "piazza");
  assert.match(sources[0].body, /gloves/);
  const versions = await repo.getDatabase().prepare("SELECT body FROM piazza_post_versions WHERE post_id=?").bind(post.id).all<{body: string}>();
  assert.equal(versions.results.length, 2);
  assert.ok(versions.results.some((v) => v.body === "Bring goggles"));
  assert.equal((await repo.searchCourseContent("总结ZZZZ99 piazza")).length, 0);
});

test("cross-language lab queries retain a confirmed Piazza answer before the result limit", async () => {
  const db = repo.getDatabase();
  for (let index = 0; index < 20; index++) {
    await db.prepare(`INSERT INTO source_items (id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(`chem:lab:${index}`, 'chem', 'file', `lab:${index}`, `Lab 1 requirements file ${index}`, 'Lab 1 requirements instructions and notebook', `hash:${index}`, 'now', 'now').run();
  }
  await db.prepare(`INSERT INTO source_items (id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind('chem:lab:assignment', 'chem', 'assignment', 'lab:assignment', 'Lab 1 assignment', 'Prepare the notebook before class.', 'hash:assignment', 'now', 'now').run();
  await repo.savePiazzaPost({ id:'piazza:test:teacher', courseId:'chem', networkId:'test', postNumber:'teacher', title:'Lab 1 discussion', body:'A student guessed that goggles are optional.', answer:'Goggles are required for Lab 1.', kind:'question', createdAt:'2026-09-15', sourceUrl:'https://piazza.com/class/test/post/teacher', folders:[], updatedAt:'2026-09-15', contentHash:'teacher' });
  await db.prepare(`INSERT INTO source_items (id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind('stats:lab:other', 'stats', 'assignment', 'lab:other', 'Lab 1 assignment', 'A different course requires a calculator.', 'hash:other', 'now', 'now').run();

  const bilingual = await repo.searchCourseContent('我的实验要求', 'chem', 8);
  assert.ok(bilingual.some((item) => item.title.includes('Lab 1')));
  assert.ok(bilingual.every((item) => item.courseId === 'chem'));

  const limited = await repo.searchCourseContent('CHMA10 lab 1 requirements', 'chem', 8);
  const teacher = limited.find((item) => item.sourceId === 'piazza:test:teacher');
  assert.ok(teacher, 'teacher answer must survive 20 higher-scoring file titles');
  assert.equal(teacher.confirmedAnswer, true);
  assert.match(teacher.body, /^教师明确回答：Goggles are required/);
  assert.match(teacher.body, /未经确认的学生发言/);
  assert.ok(limited.some((item) => item.sourceType === 'assignment'));
  assert.ok(limited.every((item) => item.courseId === 'chem'));
});

const analysis: ExtractedAnalysis = {
  summary: "完成实验并提交源文件。",
  actions: [{ title: "Lab 1", action: "完成 Lab 1", requirements: ["提交 .py 文件"], recommendedStartAt: "2026-09-13T09:00:00-04:00", inferredDueAt: null, confidence: "certain", evidence: "Submit the Python file", estimatedMinutes: 60, possiblyCancelled: false }],
  notes: [],
};

function assignment(dueAt: string): CanvasSource {
  return { id: "course-1:assignment:lab-1", courseId: "course-1", sourceType: "assignment", sourceId: "lab-1", title: "Lab 1", body: "Submit the Python file", sourceUrl: "https://example.test/lab-1", updatedAt: new Date().toISOString(), dueAt, unlockAt: null, lockAt: null, submissionState: "unsubmitted", pointsPossible: 20, prerequisiteBlocked: false };
}

test("repository stores tasks, changes, disappearance and capacity plans", async () => {
  await repo.upsertCourses([{ id: "course-1", name: "Computer Science", course_code: "CSC", term: { name: "Fall" } }]);
  const first = assignment(new Date(Date.now() + 36 * 3600000).toISOString());
  first.updatedAt = '2026-09-20T12:00:00Z';
  await repo.saveSource(first, analysis, await repo.hashSource(first), "complete");
  let tasks = await repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].duePrecision,'second');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(tasks[0].dueDate||''));
  assert.deepEqual(tasks[0].requirements, []);
  assert.equal(tasks[0].startAt, null);
  const suggested=(await (await import('../lib/kernel/service.ts')).kernel.pendingCandidates())
    .find(row=>row.attribute==='task_payload'&&row.task_id===tasks[0].id&&row.authority==='ai');
  assert.deepEqual((suggested?.value as {requirements:string[]})?.requirements,["提交 .py 文件"]);

  const changed = assignment(new Date(Date.now() + 60 * 3600000).toISOString());
  changed.updatedAt = '2026-09-21T12:00:00Z';
  await repo.saveSource(changed, analysis, await repo.hashSource(changed), "complete");
  assert.equal((await repo.listChanges())[0].type, "dates_updated");

  const missing = await repo.reconcileCourseSources("course-1", [],'2100-01-01T00:00:00Z');
  assert.equal(missing, 1);
  tasks = await repo.listTasks();
  assert.notEqual(tasks[0].canvasStatus, "possibly_superseded");
  assert.equal((await (await import('../lib/kernel/service.ts')).kernel.taskRows('course-1'))[0].source_missing,true);
  assert.equal(tasks[0].dueAt,changed.dueAt);

  const plan = await repo.saveDailyPlan("2026-09-13", tasks, true, 45);
  assert.equal(plan.capacityMinutes, 45);
  assert.ok(plan.scheduledMinutes <= plan.capacityMinutes);
  assert.ok(plan.backlogCount >= 0);
});

test("daily plan merges Canvas mirrors and never exceeds study capacity", async () => {
  const dueAt = new Date(Date.now() + 36 * 3600000).toISOString();
  const original = assignment(dueAt);
  original.id = "course-1:assignment:mirror";
  original.sourceId = "mirror";
  original.title = "Mirrored Quiz";
  original.sourceUrl = "https://example.test/mirrored-quiz";
  await repo.saveSource(original, analysis, await repo.hashSource(original), "complete");

  const mirror = { ...original, id: "course-1:quiz:mirror", sourceType: "quiz", sourceId: "quiz-mirror" };
  await repo.saveSource(mirror, analysis, await repo.hashSource(mirror), "complete");
  const matching = (await repo.listTasks()).filter((task) => task.title === "Mirrored Quiz" && task.dueAt === dueAt);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].sourceType, "assignment");

  const plan = await repo.saveDailyPlan("2026-09-14", await repo.listTasks(), true, 60);
  assert.ok(plan.scheduledMinutes <= plan.capacityMinutes);
  assert.ok(plan.mustDo.length + plan.shouldDo.length <= 1);
});
