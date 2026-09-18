import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitArchiveCourse, inferArchiveCourse, mergeArchiveSources, preferStrongDocumentMatches } from '../lib/archive-search.ts';
import type { CourseSearchResult } from '../lib/repository.ts';

const courses = [
  { id: 'stats', code: 'STAB22H3-F-LEC01/02-20269', name: 'Statistics I', enabled: true },
  { id: 'math', code: 'MATA29H3-F-LEC01-20269', name: 'Calculus I', enabled: true },
];
const source = (courseId: string, title: string, sourceType='file'): CourseSearchResult => ({
  ref: 'old', sourceId: title, courseId, courseCode: courses.find((course) => course.id === courseId)?.code || courseId,
  sourceType, title, excerpt: '目录记录', body: '所属 Module：TUTORIAL ACTIVITIES', sourceUrl: null, updatedAt: null,
});
const hit = (course_id: string, name: string, body='PDF parsed body') => ({
  id: `${name}:0`, document_id: name, position: 0, locator: '第 1 页', body, hash: 'hash', name, course_id, score: 1.4,
});

test('archive search recognizes an explicit course code without manual setup',()=>{
  assert.equal(explicitArchiveCourse('STAB22 tut 我要做什么', courses),'stats');
});

test('archive search infers one course from repeated top directory matches',()=>{
  assert.equal(inferArchiveCourse([source('stats','STAB22TUT1.pdf'),source('stats','STAB22TUT1Notes.pdf'),source('math','Tutorial')],[hit('math','other.pdf')]),'stats');
});

test('parsed document text replaces a filename-only Canvas directory record',()=>{
  const merged=mergeArchiveSources([source('stats','STAB22TUT1.pdf'),source('stats','Tutorial module','module')],[hit('stats','STAB22TUT1.pdf','Due Friday; create a frequency table and bar chart.')],courses,12);
  assert.equal(merged[0].sourceType,'document');
  assert.equal(merged[0].courseId,'stats');
  assert.match(merged[0].body,/frequency table/);
  assert.ok(!merged.some((item)=>item.sourceType==='file'&&item.title==='STAB22TUT1.pdf'));
  assert.deepEqual(merged.map((item)=>item.ref),['S1','S2']);
});

test('a strong filename match excludes generic syllabus and stale announcements for a short task question',()=>{
  const selected=preferStrongDocumentMatches('统计 tut 我要做什么',[source('stats','Old tutorial announcement','announcement')],[{...hit('stats','STAB22TUT1.pdf'),score:3.4},{...hit('stats','Syllabus.pdf'),score:1.4}]);
  assert.equal(selected.structured.length,0);
  assert.deepEqual(selected.library.map((item)=>item.name),['STAB22TUT1.pdf']);
});
