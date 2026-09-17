import test from "node:test";
import assert from "node:assert/strict";
import { presentCourse } from "../lib/course-presentation.ts";

test("Canvas course suffixes become a concise code and formal title", () => {
  assert.deepEqual(presentCourse("CHMA10H3 F 20269 All Sections", "CHMA10H3 F 20269:Introductory Chemistry I: Structure and Bonding"), {
    displayCode: "CHMA 10 H3",
    courseTitle: "Introductory Chemistry 1: Structure and Bonding",
  });
});
