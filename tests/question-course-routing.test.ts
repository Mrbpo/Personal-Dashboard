import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeQuestionCourseCodes} from '../lib/kernel/question-course-routing.ts';

const catalog=[{id:'chem-fall',code:'CHMA10H3 F 20269 All Sections'},
 {id:'chem-spring',code:'CHMA10H3 S 20271 All Sections'},
 {id:'stats',code:'STAB22H3'},{id:'calc',code:'MATA29H3'},
 {id:'old',code:'PHYB10H3',enabled:false}];
test('literal course routing preserves all courses/terms and does not match code prefixes',()=>{
 const multi=routeQuestionCourseCodes('Compare CHMA10 and STAB22 syllabus requirements',catalog);
 assert.equal(multi.status,'resolved');assert.deepEqual(multi.courseIds,['chem-fall','chem-spring','stats']);
 assert.deepEqual(routeQuestionCourseCodes('STAB22 / CHMA10',catalog).courseIds,multi.courseIds);
 for(const question of ['CHMA100 assignment','XCHMA10 assignment','CHMA10H33 assignment','PHYB10H3 assignment']){
  const route=routeQuestionCourseCodes(question,catalog);assert.notEqual(route.status,'resolved');assert.deepEqual(route.courseIds,[]);
 }
 assert.deepEqual(routeQuestionCourseCodes('MATA29H3的lab要求',catalog).courseIds,['calc']);
 assert.deepEqual(routeQuestionCourseCodes('chma 10',catalog).courseIds,['chem-fall','chem-spring']);
 const full=routeQuestionCourseCodes('CHMA10H3', [...catalog,{id:'other-campus',code:'CHMA10H1'}]);
 assert.deepEqual(full.courseIds,['chem-fall','chem-spring']);
 assert.equal(routeQuestionCourseCodes('数学的课程大纲',catalog).reason,'no-literal-course-code');
 assert.deepEqual(routeQuestionCourseCodes('CHMA10 lab notebook is not required?',catalog).courseIds,['chem-fall','chem-spring']);
 assert.deepEqual(routeQuestionCourseCodes('only CHMA10, no other courses',catalog).courseIds,['chem-fall','chem-spring']);
});
test('unknown/excluded/broader codes stay unresolved and source observations retain exact positions',()=>{
 for(const question of ['CHMA10 and XXXX99 assignments','not CHMA10, STAB22 requirements','不是CHMA10，是STAB22的作业',"Don't use CHMA10; use STAB22"]){
  const route=routeQuestionCourseCodes(question,catalog);assert.equal(route.status,'unresolved');assert.deepEqual(route.courseIds,[]);
 }
 for(const question of ['CHMA10 and all courses','所有课程的assignment','CHMA10和其他课程']){
  const route=routeQuestionCourseCodes(question,catalog);assert.equal(route.status,'broad');assert.deepEqual(route.courseIds,[]);
 }
 const question='📚 看 chma 10 和STAB22H3',route=routeQuestionCourseCodes(question,catalog);
 for(const observation of route.observations)assert.equal(question.slice(observation.startUtf16,observation.endUtf16),observation.raw);
 assert.equal(route.catalogSha256,routeQuestionCourseCodes(question,[...catalog].reverse()).catalogSha256);
 const overflow=routeQuestionCourseCodes('CHMA10',Array.from({length:257},(_,i)=>({id:`course-${i}`,code:'CHMA10H3'})));
 assert.equal(overflow.status,'unresolved');assert.equal(overflow.reason,'course-scope-capacity');assert.deepEqual(overflow.courseIds,[]);
});
