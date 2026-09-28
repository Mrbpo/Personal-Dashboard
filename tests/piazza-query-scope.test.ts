import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksForCourseIdentity, asksForEventTiming, asksOnlyForPiazza, requestedKnownCourseCodes } from '../lib/search-vocabulary.ts';

test('cross-source questions retain Canvas and PDF evidence', () => {
  assert.equal(asksOnlyForPiazza('Explain the assignment, lecture PDF and Piazza clarification'), false);
  assert.equal(asksOnlyForPiazza('结合课程大纲和 Piazza 教师回答解释实验要求'), false);
});

test('an explicit Piazza-only request stays scoped to forum posts', () => {
  assert.equal(asksOnlyForPiazza('只看 Piazza 帖子'), true);
  assert.equal(asksOnlyForPiazza('总结 Piazza 讨论'), true);
});

test('a page number does not become a course code', () => {
  assert.deepEqual(requestedKnownCourseCodes('See page 413 in the textbook', ['MAT137', 'CSC110']), []);
  assert.deepEqual(requestedKnownCourseCodes('Check MAT137 on page 413', ['MAT137', 'CSC110']), ['MAT137']);
});

test('midterm dates are not mistaken for course identity questions', () => {
  assert.equal(asksForCourseIdentity('What date will the midterm be held on?'), false);
  assert.equal(asksForCourseIdentity('我的课程有哪些？'), true);
});

test('exam content stays in document search while exam timing reads the kernel', () => {
  assert.equal(asksForEventTiming('考试范围是什么？'), false);
  assert.equal(asksForEventTiming('What topics are on the final exam?'), false);
  assert.equal(asksForEventTiming('考试是什么时候？'), true);
  assert.equal(asksForEventTiming('What date will the midterm be held on?'), true);
});
