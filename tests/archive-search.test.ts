import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitArchiveCourse, inferActivityCourse, inferArchiveCourse, mergeArchiveSources, preferStrongDocumentMatches } from '../lib/archive-search.ts';
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

test('archive search recognizes an unambiguous subject name before generic tutorial matches',()=>{
  assert.equal(explicitArchiveCourse('统计 tut 我要做什么', courses),'stats');
  assert.equal(explicitArchiveCourse('微积分 tutorial 的要求', courses),'math');
});

test('archive search infers one course from repeated top directory matches',()=>{
  assert.equal(inferArchiveCourse([source('stats','STAB22TUT1.pdf'),source('stats','STAB22TUT1Notes.pdf'),source('math','Tutorial')],[hit('math','other.pdf')]),'stats');
});

test('a numbered activity document outranks generic tutorial announcements when inferring course',()=>{
  assert.equal(inferActivityCourse('tutorial 1 用 RStudio 还是 Excel',[{...hit('chem','CHMA tutorial scheduling.txt'),score:4.2},{...hit('stats','STAB22TUT1.pdf'),score:3.4},{...hit('stats','STAB22TUT1Notes.pdf'),score:2.5}]),'stats');
});

test('parsed document text replaces a filename-only Canvas directory record',()=>{
  const merged=mergeArchiveSources([source('stats','STAB22TUT1.pdf'),source('stats','Tutorial module','module')],[hit('stats','STAB22TUT1.pdf','Due Friday; create a frequency table and bar chart.')],courses,12);
  assert.equal(merged[0].sourceType,'document');
  assert.equal(merged[0].courseId,'stats');
  assert.match(merged[0].body,/frequency table/);
  assert.ok(!merged.some((item)=>item.sourceType==='file'&&item.title==='STAB22TUT1.pdf'));
  assert.deepEqual(merged.map((item)=>item.ref),['S1','S2']);
});

test('a strong filename match excludes stale announcements but keeps confirmed Piazza and Canvas requirements',()=>{
  const selected=preferStrongDocumentMatches('统计 tut 我要做什么',[source('stats','Old tutorial announcement','announcement')],[{...hit('stats','STAB22TUT1Notes.pdf'),score:3.5},{...hit('stats','STAB22TUT1.pdf'),score:3.4},{...hit('stats','No tutorial sessions this week.txt'),score:3.3},{...hit('stats','TUTORIAL ACTIVITIES.txt'),score:3.2},{...hit('stats','Syllabus.pdf'),score:1.4}]);
  assert.equal(selected.structured.length,0);
  assert.deepEqual(selected.library.map((item)=>item.name),['STAB22TUT1Notes.pdf','STAB22TUT1.pdf']);
  const evidence=preferStrongDocumentMatches('Lab 1 要求',[
    source('stats','Old lab announcement','announcement'),
    {...source('stats','Lab 1 discussion','piazza'),confirmedAnswer:true},
    source('stats','Lab 1 assignment','assignment'),
    source('stats','Lab 2 assignment','assignment'),
  ],[{...hit('stats','Lab1.pdf'),score:3.6}]);
  assert.deepEqual(evidence.structured.map((item)=>item.title),['Lab 1 discussion','Lab 1 assignment']);
  const merged=mergeArchiveSources(evidence.structured,evidence.library,courses,3);
  assert.deepEqual(merged.map((item)=>item.sourceType),['document','piazza','assignment']);
});

test('an explicit tutorial number keeps only documents for that tutorial',()=>{
  const selected=preferStrongDocumentMatches('tutorial 1 要完成哪些图表',[],[{...hit('stats','STAB22TUT1Notes.pdf'),score:3.5},{...hit('stats','STAB22TUT1.pdf'),score:3.4},{...hit('stats','Tutorial registration.txt'),score:3.3},{...hit('stats','STAB22TUT2.pdf'),score:3.2}]);
  assert.deepEqual(selected.library.map((item)=>item.name),['STAB22TUT1Notes.pdf','STAB22TUT1.pdf']);
});
