import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, parseIcs } from "../lib/schedule-import.ts";

test("ICS imports timed and multi-day events", () => {
  const events = parseIcs(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:midterm-1\r\nDTSTART:20260915T140000Z\r\nDTEND:20260918T160000Z\r\nSUMMARY:复习期中考试\r\nDESCRIPTION:完成第 1-4 章\r\nEND:VEVENT\r\nEND:VCALENDAR`);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "复习期中考试");
  assert.equal(events[0].startAt, "2026-09-15T14:00:00Z");
  assert.equal(events[0].endAt, "2026-09-18T16:00:00Z");
});

test("ICS treats an all-day DTEND as exclusive", () => {
  const [event] = parseIcs(`BEGIN:VEVENT\nUID:reading-week\nDTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261017\nSUMMARY:Reading Week\nEND:VEVENT`);
  assert.equal(event.allDay, true);
  assert.equal(new Date(event.endAt).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }), "2026-10-16");
});

test("CSV imports Chinese headers and quoted values", () => {
  const [event] = parseCsv(`标题,开始,结束,说明\n"线性代数,复习",2026-09-20,2026-09-22,第 3 章`);
  assert.equal(event.title, "线性代数,复习");
  assert.equal(event.allDay, true);
  assert.equal(event.description, "第 3 章");
});
