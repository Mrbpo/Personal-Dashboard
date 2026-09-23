import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL=':memory:';
const { database:db, searchIndexAvailable } = await import('../lib/database.ts');
const repo = await import('../lib/repository.ts');

test('FTS finds old Canvas and Piazza evidence beyond the former recency limits', async () => {
  assert.equal(await searchIndexAvailable(), true);
  await repo.upsertCourses([{id:'chem',name:'Chemistry',course_code:'CHMA10H3'},{id:'stats',name:'Statistics',course_code:'STAB22H3'}]);
  await db.prepare(`INSERT INTO source_items (id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind('old-canvas','chem','page','old-canvas','Spectrophotometry lab procedure','Use a cuvette','old-canvas','2025','2025').run();
  await repo.savePiazzaPost({id:'old-piazza',courseId:'chem',networkId:'chem',postNumber:'old',title:'Lab question',body:'Question about calorimetry',answer:'Calorimetry requires a covered cup.',kind:'question',createdAt:'2025',sourceUrl:'https://piazza.com/old',folders:[],updatedAt:'2025',contentHash:'old'});
  const total=2600;
  for(let start=0;start<total;start+=200){
    const statements=[];
    for(let index=start;index<Math.min(start+200,total);index++){
      statements.push(db.prepare(`INSERT INTO source_items (id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(`new-canvas-${index}`,'chem','announcement',`new-${index}`,`General notice ${index}`,'Unrelated course information',`hash-${index}`,'2026','2026'));
      if(index<1200) statements.push(db.prepare(`INSERT INTO piazza_posts (id,course_id,network_id,post_number,title,body,content_hash,synced_at,remote_updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(`new-post-${index}`,'chem','chem',String(index),`General post ${index}`,'Unrelated discussion',`post-hash-${index}`,'2026','2026'));
    }
    await db.batch(statements);
  }
  assert.ok((await repo.searchCourseContent('CHMA10 spectrophotometry','chem',8)).some((item)=>item.sourceId==='old-canvas'));
  const answer=(await repo.searchCourseContent('CHMA10 calorimetry','chem',8)).find((item)=>item.sourceId==='old-piazza');
  assert.ok(answer?.confirmedAnswer);
  assert.match(answer.body,/covered cup/);
  assert.ok(!(await repo.searchCourseContent('STAB22 calorimetry','stats',8)).some((item)=>item.sourceId==='old-piazza'));

  await db.prepare("UPDATE piazza_posts SET answer='Use a sealed calorimeter.' WHERE id='old-piazza'").run();
  assert.ok((await repo.searchCourseContent('sealed calorimeter','chem',8)).some((item)=>item.sourceId==='old-piazza'));
  assert.equal((await repo.searchCourseContent('covered cup','chem',8)).some((item)=>item.sourceId==='old-piazza'),false);
  await db.prepare("UPDATE piazza_posts SET is_active=0 WHERE id='old-piazza'").run();
  assert.equal((await repo.searchCourseContent('sealed calorimeter','chem',8)).length,0);
  await db.prepare("UPDATE courses SET enabled=0 WHERE id='chem'").run();
  assert.equal((await repo.searchCourseContent('spectrophotometry','chem',8)).length,0);
});
