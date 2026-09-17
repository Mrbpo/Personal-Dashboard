import type { ImportedScheduleEvent } from "./repository.ts";

function unescapeIcs(value: string) {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function parseIcsDate(value: string) {
  const raw = value.trim();
  if (/^\d{8}$/.test(raw)) return { value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00`, allDay: true };
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) throw new Error("日程中存在无法识别的日期：" + raw);
  return { value: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}`, allDay: false };
}

export function parseIcs(text: string): ImportedScheduleEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map((block, index) => {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const split = line.indexOf(":");
      if (split < 0) continue;
      values.set(line.slice(0, split).split(";")[0].toUpperCase(), line.slice(split + 1));
    }
    const start = parseIcsDate(values.get("DTSTART") || "");
    const rawEnd = values.get("DTEND") ? parseIcsDate(values.get("DTEND")!) : start;
    let endAt = rawEnd.value;
    if (start.allDay && values.get("DTEND")) endAt = new Date(new Date(rawEnd.value).getTime() - 1).toISOString();
    return {
      uid: unescapeIcs(values.get("UID") || `event-${index}-${start.value}`),
      title: unescapeIcs(values.get("SUMMARY") || "未命名日程"),
      description: unescapeIcs(values.get("DESCRIPTION") || ""),
      startAt: start.value,
      endAt,
      allDay: start.allDay,
    };
  });
}

function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseCsv(text: string): ImportedScheduleEvent[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.toLowerCase().replace(/^\ufeff/, ""));
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const titleIndex = column("title", "summary", "name", "标题");
  const startIndex = column("start", "start_at", "start date", "开始", "开始时间");
  const endIndex = column("end", "end_at", "end date", "结束", "结束时间");
  const descriptionIndex = column("description", "details", "备注", "说明");
  if (titleIndex < 0 || startIndex < 0) throw new Error("CSV 至少需要 title 和 start 两列");
  return rows.slice(1).map((row, index) => {
    const start = new Date(row[startIndex]);
    const end = new Date(row[endIndex] || row[startIndex]);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error(`CSV 第 ${index + 2} 行日期无效`);
    return { uid: `csv-${index}-${start.toISOString()}-${row[titleIndex]}`, title: row[titleIndex] || "未命名日程", description: descriptionIndex >= 0 ? row[descriptionIndex] || "" : "", startAt: start.toISOString(), endAt: end.toISOString(), allDay: /^\d{4}-\d{2}-\d{2}$/.test(row[startIndex]) };
  });
}

export function parseScheduleFile(name: string, text: string) {
  if (/\.ics$/i.test(name)) return parseIcs(text);
  if (/\.csv$/i.test(name)) return parseCsv(text);
  throw new Error("仅支持 .ics 和 .csv 日程文件");
}
