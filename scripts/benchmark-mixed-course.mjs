import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// A controlled integration fixture: public SyllabusQA/HotpotQA background plus
// Canvas-, PDF-, mail- and Piazza-shaped course records with known answers.
// Synthetic records are explicitly labeled; no private course material is used.
if (!process.env.KERNEL_DATABASE_URL) throw new Error('Use an isolated PostgreSQL database');
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
await mkdir(root, { recursive: true });
process.env.DATABASE_URL ||= `file:${resolve(root, 'mixed.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { kernel } = await import('../lib/kernel/service.ts');
const { searchArchiveForAnswer } = await import('../lib/archive-search.ts');
const { askKernel } = await import('../lib/kernel/ask.ts');
const { splitText } = await import('../lib/library.ts');
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => value.toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
const owner = 'mixed-benchmark-owner';
const topics = [
  ['enzyme inhibition', 'SVG', 'Methods', 'Results', 'competitive inhibition', 'active site'],
  ['linear regression', 'CSV', 'Model', 'Diagnostics', 'heteroskedasticity', 'residual spread'],
  ['matrix eigenvalues', 'JSONL', 'Derivation', 'Check', 'spectral radius', 'largest eigenvalue magnitude'],
  ['geographic mapping', 'GeoJSON', 'Projection', 'Legend', 'Mercator distortion', 'latitude dependent stretching'],
  ['cell microscopy', 'TIFF', 'Calibration', 'Observations', 'pixel scale', 'micrometers per pixel'],
  ['sound analysis', 'WAV', 'Sampling', 'Spectrum', 'aliasing', 'frequency folding'],
  ['climate simulation', 'HDF5', 'Parameters', 'Uncertainty', 'ensemble mean', 'average across runs'],
  ['database indexing', 'PARQUET', 'Schema', 'Benchmark', 'selectivity', 'fraction of matching rows'],
  ['genome alignment', 'FASTA', 'Sequences', 'Alignment', 'gap penalty', 'cost of an insertion or deletion'],
  ['chemical kinetics', 'XML', 'Rate Law', 'Fit', 'reaction order', 'exponent of concentration'],
];
const course = i => ({ id: `mixed-course-${i + 1}`, code: `MIX${201 + i}` });
async function sourceItem(id, courseId, type, title, body) {
  const now = '2026-09-01T00:00:00Z';
  return database.prepare(`INSERT OR IGNORE INTO source_items
    (id,course_id,source_type,source_id,title,body,source_url,content_hash,remote_updated_at,dates_json,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, courseId, type, id, title, body, `https://example.edu/${id}`, hash(body), now, '{}', now, now);
}
function library(id, courseId, name, body, origin = 'benchmark') {
  return [database.prepare(`INSERT OR IGNORE INTO library_documents
    (id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).bind(id, owner, courseId, origin, JSON.stringify([courseId, name]), 'course archive', name, 'text/plain', hash(body), body.length, 'ready', '2026-09-01T00:00:00Z'),
    database.prepare('INSERT OR IGNORE INTO library_chunks (id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:0`, id, 0, 'page 1', body, hash(body))];
}
let inserts = [];
for (let i = 0; i < topics.length; i++) {
  const [topic, format, first, second, concept, definition] = topics[i];
  const { id, code } = course(i);
  if (!(await kernel.getCourse(id))) await kernel.upsertCourse({ id, course_code: code, name: `Study Lab ${i + 1}: ${topic}`, enabled: true }, 'canvas');
  const lab = `Lab ${i + 1}`;
  const assignmentBody = `${lab} on ${topic}: write a ${first} section and a ${second} section. Submit the analysis with a TXT output unless later clarified by teaching staff. Neither section may be omitted. The lecture PDF explains ${concept}.`;
  if (!(await kernel.taskRows(id)).some(row => row.source_item_id === `mixed:canvas:${i}`))
    await kernel.ingestCanvasSource({ id: `mixed:canvas:${i}`, courseId: id, sourceType: 'assignment', sourceId: `lab-${i + 1}`,
      title: `${code} ${lab} Canvas assignment`, body: assignmentBody, sourceUrl: `https://example.edu/mixed:canvas:${i}`,
      updatedAt: '2026-09-01T00:00:00Z', dueAt: null, unlockAt: null, lockAt: null }, null, hash(assignmentBody));
  inserts.push(await sourceItem(`mixed:syllabus:${i}`, id, 'syllabus', `${code} course outline`, `This course covers ${topic}. For ${lab}, the initial handout lists a TXT output. The current submission details are in the Canvas assignment and staff Piazza clarification.`));
  inserts.push(await sourceItem(`mixed:canvas:${i}`, id, 'assignment', `${code} ${lab} Canvas assignment`, assignmentBody));
  const pdf = `Lecture PDF for ${code} ${lab}: ${topic}. The ${first} section describes the process; the ${second} section reports findings. In this lecture, ${concept} means ${definition}. The lab handout names TXT as the initial export format; check the instructor answer for any change. `;
  inserts.push(...library(`mixed:pdf:${i}`, id, `${code} ${lab} lecture.pdf`, pdf.repeat(6), 'pdf'));
  inserts.push(...library(`mixed:mail:${i}`, id, `${code} weekly mail`, `Weekly note for ${lab}: refer to the official Canvas assignment and the staff Piazza thread on ${topic}. Student suggestions are not official requirements.`, 'gmail'));
  inserts.push(database.prepare(`INSERT OR IGNORE INTO piazza_posts
    (id,course_id,network_id,post_number,title,body,answer,kind,created_at,source_url,folders_json,content_hash,remote_updated_at,synced_at,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(`mixed:staff:${i}`, id, code, String(i * 2 + 1), `${code} ${lab} output format clarification`, `A student asks whether the TXT export in the handout is still required for ${lab} on ${topic}.`, `Instructor clarification: use ${format} for the final output in ${lab}; this supersedes TXT. Keep both the ${first} and ${second} sections from the Canvas assignment.`, 'question', '2026-09-02T00:00:00Z', `https://example.edu/piazza/${i}/staff`, '[]', hash(`staff:${format}`), '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z'));
  inserts.push(database.prepare(`INSERT OR IGNORE INTO piazza_posts
    (id,course_id,network_id,post_number,title,body,answer,kind,created_at,source_url,folders_json,content_hash,remote_updated_at,synced_at,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(`mixed:student:${i}`, id, code, String(i * 2 + 2), `${code} ${lab} student suggestion`, `A student speculates that the ${first} section may be omitted from ${lab}. This is not a staff answer.`, '', 'question', '2026-09-02T00:00:00Z', `https://example.edu/piazza/${i}/student`, '[]', hash(`student:${first}`), '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z'));
}
if (inserts.length) await database.batch(inserts);
// Add authentic, varied course outlines as cross-course and within-course
// distractors. They are public SyllabusQA documents, separate from the
// controlled Canvas/Piazza claims above.
const syllabusTree = await (await fetch('https://api.github.com/repos/umass-ml4ed/SyllabusQA/git/trees/main?recursive=1')).json();
const outlines = syllabusTree.tree.filter(item => /^syllabi\/syllabi_redacted\/text\/[^/]+\.txt$/.test(item.path));
inserts = [];
for (const [position, item] of outlines.entries()) {
  const name = item.path.split('/').at(-1).replace(/\.txt$/, '');
  const body = await readFile(resolve(root, `syllabus-${hash(name)}.txt`), 'utf8');
  const id = `mixed:public-syllabus:${hash(name)}`, targetCourse = course(position % 10).id;
  inserts.push(database.prepare(`INSERT OR IGNORE INTO library_documents
    (id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).bind(id, owner, targetCourse, 'public-syllabus', JSON.stringify([targetCourse, name]),
      'public course outlines', name, 'text/plain', hash(body), body.length, 'ready', '2026-09-01T00:00:00Z'));
  for (const [chunk, text] of splitText(body).entries()) inserts.push(database.prepare(
    'INSERT OR IGNORE INTO library_chunks (id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
    .bind(`${id}:${chunk}`, id, chunk, `page ${chunk + 1}`, text, hash(text)));
  if (inserts.length >= 300) { await database.batch(inserts); inserts = []; }
}
if (inserts.length) await database.batch(inserts);
// 2,000 unrelated public background records make the search corpus large and
// mixed; answers still require the course-specific records above.
const hotpot = (await Promise.all(Array.from({ length: 10 }, (_, i) => readFile(resolve(root, `hotpot_rows_${i * 100}.json`), 'utf8'))))
  .flatMap(text => JSON.parse(text).rows.map(item => item.row));
const background = new Map();
for (const row of hotpot) {
  for (let j = 0; j < row.context.title.length; j++) {
    const title = row.context.title[j];
    if (!background.has(title)) background.set(title, row.context.sentences[j].join(' '));
    if (background.size >= 2000) break;
  }
  if (background.size >= 2000) break;
}
let index = 0; inserts = [];
for (const [title, body] of background) {
  inserts.push(...library(`mixed:bg:${hash(title)}`, course(index++ % 10).id, title, body, 'public-background'));
  if (inserts.length >= 300) { await database.batch(inserts); inserts = []; }
}
if (inserts.length) await database.batch(inserts);

const cases = [];
for (let i = 0; i < topics.length; i++) {
  const [topic, format, first, second, concept, definition] = topics[i];
  const { id, code } = course(i), lab = `Lab ${i + 1}`;
  cases.push({ courseId: id, question: `For ${code} ${lab} on ${topic}, what final output format should I use?`, expected: [format], proof: [`mixed:staff:${i}`, `mixed:canvas:${i}`] });
  cases.push({ courseId: id, question: `Which two sections are required in ${code} ${lab}?`, expected: [first, second], proof: [`mixed:canvas:${i}`, `mixed:pdf:${i}`] });
  cases.push({ courseId: id, question: `A student said the ${first} section can be skipped in ${code} ${lab}. Is that confirmed?`, expected: [first], proof: [`mixed:student:${i}`, `mixed:staff:${i}`] });
  cases.push({ courseId: id, question: `In the ${code} ${lab} lecture, what does ${concept} mean?`, expected: [definition], proof: [`mixed:pdf:${i}`] });
  cases.push({ courseId: id, question: `Explain the ${code} ${lab} requirements using the assignment, lecture and Piazza clarification.`, expected: [format, first, second], proof: [`mixed:canvas:${i}`, `mixed:pdf:${i}`, `mixed:staff:${i}`] });
}
const results = [];
const withAnswers = process.argv.includes('--answers');
for (const row of cases) {
  const archive = await searchArchiveForAnswer(owner, row.question, row.courseId, 18);
  const retrieved = archive.sources.map(item => item.sourceId);
  const item = { ...row, retrieved, allProofFound: row.proof.every(id => retrieved.includes(id)) };
  if (withAnswers) {
    try { const answer = await askKernel(owner, row.question, row.courseId);
      Object.assign(item, { answer: answer.answer, cited: answer.citations.map(c => c.sourceId),
        allExpectedPresent: row.expected.every(value => normalize(answer.answer).includes(normalize(value))) });
    } catch (error) { Object.assign(item, { error: String(error), allExpectedPresent: false }); }
  }
  results.push(item);
  if (withAnswers) await writeFile(resolve(root, 'mixed-course-results.json'), JSON.stringify({ cases: results }, null, 2));
  if (withAnswers && results.length % 10 === 0) console.log(`Answered ${results.length}/${cases.length}`);
}
await writeFile(resolve(root, 'mixed-course-results.json'), JSON.stringify({ cases: results }, null, 2));
console.log(JSON.stringify({ documents: background.size + outlines.length + 20, sourceItems: 20, piazzaPosts: 20, queries: results.length,
  allProofFound: results.filter(row => row.allProofFound).length,
  ...(withAnswers ? { allExpectedPresent: results.filter(row => row.allExpectedPresent).length } : {}) }));
