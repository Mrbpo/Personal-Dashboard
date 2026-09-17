import type { LearningTask } from "./domain.ts";

function compact(value: string, limit = 42) {
  const text = value.replace(/\s+/g, " ").replace(/\s*\(upload here\)\s*/gi, "").trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

export function conciseTaskAction(task: LearningTask) {
  const title = task.title.replace(/\u00a0/g, " ");
  const lab = title.match(/Lab\s*#?0?(\d+)/i)?.[1];
  const chapter = title.match(/Ch(?:apter)?\s*(\d+)/i)?.[1];
  const problemSet = title.match(/Problem Set\s*(\d+)/i)?.[1];

  if (/pre[- ]?lab quiz/i.test(title)) return `完成 Lab ${lab || ""} 课前测验`.replace(/\s+/g, " ");
  if (/post[- ]?lab/i.test(title)) return `提交 Lab ${lab || ""} 实验后任务`.replace(/\s+/g, " ");
  if (/notebook mark/i.test(title)) return `完成 Lab ${lab || ""} 实验记录`.replace(/\s+/g, " ");
  if (/safety mark/i.test(title)) return `确认 Lab ${lab || ""} 安全规范`.replace(/\s+/g, " ");
  if (/attendance/i.test(title) && lab) return `确认 Lab ${lab} 出勤`;
  if (/homework assignment/i.test(title) && chapter) return `完成第 ${chapter} 章作业`;
  if (/problem set/i.test(title)) return `完成习题集${problemSet ? ` ${problemSet}` : ""}`;
  if (/research essay/i.test(title)) return "提交研究论文";
  if (/contract/i.test(title)) return `提交${/WHMIS/i.test(title) ? " WHMIS" : "课程"}确认书`;

  const aiAction = task.action.replace(/^(查看并处理|完成并提交|处理)[:：]?\s*/u, "").trim();
  if (/[㐀-鿿]/u.test(aiAction) && aiAction.length <= 36) return compact(task.action, 36);
  const verb = task.sourceType === "announcement" ? "阅读通知" : task.sourceType === "file" ? "查看资料" : "完成";
  return `${verb}：${compact(title, 32)}`;
}

export function conciseRequirement(task: LearningTask) {
  const requirement = task.requirements.find((item) => item.trim().length > 0);
  return requirement ? compact(requirement, 72) : "展开查看 Canvas 原始要求与分析依据";
}
