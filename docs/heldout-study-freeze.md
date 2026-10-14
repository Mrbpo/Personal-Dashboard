# Heldout study input freeze for Issue #68

This PR prepares input candidates only. It has not executed retrieval, imported a corpus into a database, called a model, graded an answer, or completed any 100% acceptance round. [Issue #68](https://github.com/Mrbpo/Personal-Dashboard/issues/68) still requires three distinct actual 100% document runs and three PDF runs, including the agreed data-state transitions, followed by expanded public material noise.

The selection protocol was committed as `24fb82f` before downloading author question/gold archives. Its fixed seed is `issue-68-heldout-study-v1`; the rule orders original question IDs by SHA-256 of seed, source name, and original ID, excludes previously exposed materials/questions and already selected question text, and selects 50 distinct questions. Answerability, answer length, evidence shape, conflicts, difficulty, and algorithm results do not select questions. All author annotations remain unchanged.

## Frozen material and question candidates

| Proposed combination | New QASPER papers / selected questions | Separate complete forum background / selected retrieval queries |
| --- | --- | --- |
| Validation + physics | 181 / 50, covering 45 papers | Physics: 38,316 posts / 50 of 1,039 queries |
| Test + statistics | 416 / 50, covering 46 papers | Statistics: 42,269 posts / 50 of 652 queries |
| Unseen train + Mathematica | 888 / 50, covering 49 papers | Mathematica: 16,705 posts / 50 of 804 queries |

These are three different material/source combinations. Mathematica is the author's computer algebra forum subset; it is not a general mathematics forum. The forum background is frozen now as raw Parquet. It has not been ingested or used as expanded noise. The later expanded-noise gate has not run.

QASPER supplies original scientific reading questions, all answer annotations, and evidence strings. Forum gold supplies author duplicate-document judgments only: physics 1,933 qrel rows, statistics 913, and Mathematica 1,358. The complete query sets and qrels are retained, alongside 50 deterministic supplementary queries per forum. A duplicate-document match cannot certify a final factual answer. No answer or evidence span was invented for forum questions.

## Primary sources and immutable bytes

- [Ai2 QASPER author page](https://allenai.org/data/qasper), [author-hosted loader at revision fdc9d821](https://huggingface.co/datasets/allenai/qasper/blob/fdc9d8214fbab5dd782958601db4d678e6934a54/qasper.py): release v0.3, official card license CC BY 4.0. The author S3 train/dev archive is 10,835,856 bytes, pinned to S3 version `PVl1ofaATXMYFgEb.9Rei3dJqZ4XzhBg`; the test/evaluator archive is 3,865,061 bytes, version `MWliK0rgHeKzeNbQ_AmemEkriliL7eHF`. Both original compressed bytes and extracted JSON bytes are retained.
- [Official BeIR CQADupStack snapshot](https://huggingface.co/datasets/BeIR/cqadupstack/tree/e84b7220ce5a4e6c49aeb568983b0ec5a7584c2c): revision `e84b7220ce5a4e6c49aeb568983b0ec5a7584c2c`, official card license CC BY-SA 4.0. All three corpus and query Parquet files are downloaded from this exact revision; their SHA-256 values match the official LFS hashes.
- [Official BeIR qrels](https://huggingface.co/datasets/BeIR/cqadupstack-qrels/tree/13595a9f221256a9a21e91c8b0fed3563382b6a7): revision `13595a9f221256a9a21e91c8b0fed3563382b6a7`, same official card license. Original TSV rows are preserved as strings without relevance changes.
- The [full official CQADupStack archive index](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/) reports 5,343,728,040 bytes for the combined ZIP. It was not downloaded. Individual official forum files provide complete backgrounds within the task's cap.
- [Original CQADupStack authors' project](https://github.com/D1Doris/CQADupStack) identifies the source collection; its Apache 2.0 code license is distinct from the BeIR data card's license recorded for these bytes.

The local manifest records every source URL, revision/version, license label, source byte count, SHA-256, response metadata, original IDs, author gold, evidence strings, raw-span positions where exact, prior input hashes, and deterministic selection. Official query rows were captured through the Hugging Face rows API without installing a Parquet reader. That API does not expose a content revision. Repository SHA was checked after capture, but exact rows-to-Parquet equality remains pending until an existing reader can compare them; this limitation is explicit in the manifest.

Actual new download: **70,479,744 bytes**, plus a conservative **1,000,000-byte reserve** for preliminary metadata research, below the 150,000,000-byte cap. Download charges are persistent, including bytes from interrupted attempts. Derived JSON is local expansion, not additional download: QASPER material files total 125,814,574 bytes and represent 1,485 new author-released text papers. Forum source backgrounds total 97,290 posts and remain complete raw Parquet.

## Exclusion and gold integrity

The supplied prior calibration contains all 63 SyllabusQA syllabi. [SyllabusQA's official repository](https://github.com/umass-ml4ed/SyllabusQA/tree/969f807bc29b5bb1af58e7aad387162f862cb253/data/dataset_split) has additional train/validation/test questions, but these cannot satisfy unseen **material** in this task. It is an ineligible formal-round material candidate.

The old 100 QASPER papers were actually in validation, rather than train: validation 281 minus 100 seen papers leaves 181; test and train have zero old paper-ID overlap. The exclusion audit covers all old frozen corpus files, both old question files, and all five previously exposed raw QASPER pages. It records 100 old QASPER material IDs, 424 question IDs, and 515 normalized question texts. New QASPER paper IDs are disjoint across all three candidates; selected question IDs and normalized text have zero old or cross-round overlap. The complete forum text overlap audit is pending Parquet conversion; selected forum query text has zero old-question overlap.

| QASPER candidate | Any unanswerable annotation | All annotations unanswerable | Conflicting answerability |
| --- | --- | --- | --- |
| Validation | 6 | 3 | 3 |
| Test | 9 | 3 | 6 |
| Unseen train | 2 | 2 | 0 |

All selected questions remain in each 50-question denominator. Multiple answers and conflicts are not consolidated or rewritten. Titles, full-text sections/paragraphs, figure/table captions, and original author material structures are retained; null headings are rendered as empty text while remaining null in the original structure.

## Query context and evidence readiness

QASPER associates each question with a paper. Bare questions such as “what model” can lack a unique paper reference in a global corpus. The separate `annotations/*.title-context.json` files model a **controlled user-selected title** from the author's paper association. They keep the original query unchanged and provide the author's title in a distinct user-input field. Audit IDs stay in an audit-only object. This measures selected-title-scoped QA; a single-paper document-ID filter cannot establish cross-material retrieval. A formal harness must state its scope and resolve the supplied title against the corpus before asserting any global retrieval claim.

Across 150 selected questions, 377 author evidence strings have 340 exact raw occurrences for 337 strings. The other **40 strings remain unchanged**: 39 contain the author's `FLOAT SELECTED: ` marker and reference an exact retained figure/table caption; one validation paragraph matches only after whitespace normalization. NFKC alone does not resolve that paragraph. These are diagnostics, not literal raw-span alignments. No normalized-only position is labeled as a raw author span.

The JSON release includes captions but not figure/table image pixels. Caption references therefore do not demonstrate that numerical table contents or image-only evidence are available. These questions are not removed or replaced; any actual answer failure must count against the original denominator. Original PDF/figure acquisition and alignment, if needed, require a separate explicit material preparation step within the remaining byte budget.

## Reproduce and verify

Use an existing Python 3.10+ runtime; the scripts use only its standard library. No package installation, model, service, database, or UI is needed. Local private output is already ignored by `/data/`.

```powershell
& '<existing-python>' scripts/freeze-heldout-study.py `
  --previous-frozen 'D:/Desktop/Files/canvas-study-dashboard-text-100/data/text-calibration-frozen-run' `
  --previous-cache 'D:/Desktop/Files/canvas-study-dashboard-v1-ai/data/benchmark' `
  --include-forums
& '<existing-python>' scripts/annotate-heldout-study.py
& '<existing-python>' scripts/verify-heldout-study.py `
  --previous-frozen 'D:/Desktop/Files/canvas-study-dashboard-text-100/data/text-calibration-frozen-run' `
  --previous-cache 'D:/Desktop/Files/canvas-study-dashboard-v1-ai/data/benchmark'
node --experimental-strip-types --test tests/heldout-study-freeze.test.ts
```

Default output is `data/heldout-study-v1`. A completed freeze refuses overwrite. Original author materials/gold and the base manifest are immutable; context/evidence diagnostics have a separate manifest bound to the base manifest SHA-256. Do not import `*.cases.json` or the original gold JSON as searchable material. QASPER `*.materials.jsonl` contains no question/answer fields.

Verified locally: nine input-integrity tests; all 40 source receipts, 15 base derived files, and 150 context/evidence sidecar cases; byte-for-byte author JSON extraction; exact original QA/gold equality; deterministic selection; complete eligible QASPER materials; prior/cross-round exclusion; forum original qrels/query capture equality; download cap. Base manifest SHA-256 is `47defae531100a6c120cb5f911fbd822c4fc2eab8909e319430ffc0535677efc`. This is input-integrity verification, not an acceptance score. UI screenshots are not applicable.

Remaining work: complete Parquet conversion and original-query parity/full-text overlap checks with an existing reader; preserve the 40 nonliteral evidence cases through formal evaluation; decide the visible query scope and any separately labeled source/time/permission fixtures; freeze state-transition and scoring protocols; execute the actual acceptance runs and later expanded-noise gate. No core code, production state, merge, or release changed in this task.
