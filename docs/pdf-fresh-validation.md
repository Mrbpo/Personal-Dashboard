# Fresh public learning corpus (2026-10-13)

Preparation belongs to Issue #55. This corpus is independent of the earlier 107-PDF heldout set. No original PDF hash matches that earlier set. No retrieval or paid model was used to prepare the new questions, references, or expected pages.

## Sources and frozen size

| Group | Official course | PDFs | Original pages | Questions | PDFs covered by questions |
| --- | --- | ---: | ---: | ---: | ---: |
| `ml6867` | [MIT 6.867 Machine Learning, Fall 2006](https://ocw.mit.edu/courses/6-867-machine-learning-fall-2006/) | 36 | 238 | 50 | 27 |
| `algorithms6046` | [MIT 6.046J Design and Analysis of Algorithms, Spring 2015](https://ocw.mit.edu/courses/6-046j-design-and-analysis-of-algorithms-spring-2015/) | 45 | 506 | 50 | 25 |
| `systems6004` | [MIT 6.004 Computation Structures, Spring 2009](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2009/) | 40 | 326 | 50 | 25 |

Total: **121 PDFs, 1,070 original pages, 28,297,022 bytes**. The download cap is 200 MiB. Lecture notes, exercises, solutions and selected course-provided exam/lab material are retained. Official syllabus HTML and available calendar HTML remain original supporting assets; they are not represented as fabricated PDF pages. The 6.036 Fall 2020 OCW page links to an interactive external course instead of a self-contained PDF collection, so the machine-learning set uses 6.867. The computation-structures set uses the more complete 2009 PDF publication.

The PDFs retain original bytes, source URLs and SHA-256 hashes. [MIT OCW terms](https://ocw.mit.edu/pages/privacy-and-terms-of-use/) specify CC BY-NC-SA 4.0; separately marked third-party material is excluded from that license. Attribution remains in the originals and manifests. Assets are local ignored evaluation data, not committed course-content redistribution.

## Location and formats

Ignored directory: `data/pdf-fresh-20261013/`. Group order is `ml6867,algorithms6046,systems6004`.

- Each group has `manifest.json`: an array of `{path,group,title,source_url,sha256,bytes,page_count,...}`. `path` is the original filename without the OCW asset-URL hash prefix.
- Each original has `<filename>.pdf.reference.json`: original file hash, official URL and independent pypdf text for each actual 1-based PDF page.
- Each group has `questions.json`: `{questions:[{id,group,query,expected:[{path,pages:[actualPage]}],reference:{path,page,anchor,excerpt,sourceUrl,sha256}}]}`.
- Each evidence anchor is an exact native-original literal of at least ten characters. Excerpts are at most 1,000 characters and independently hashed. Questions contain no filenames or page-number hints. Expected pages were selected from original source content before any retrieval results existed.
- `bundle-checksums.sha256` preserves original PDFs, independent references, manifests, frozen questions and supporting source-page hashes.
- `freeze.json` records counts and per-group manifest/question hashes. `frozen-expectation.sha256` hashes the compact JSON concatenation of the 150 questions in the stated group order, matching the benchmark convention.

Actual PDF pages include OCW cover pages. A slide number printed in the footer is not used as a page identifier. There are no gold answers taken from title-only or contents pages for explanation questions. Mathematical layout and native font defects remain in the independent references; preparation does not guess missing symbols or claim formula transcription is correct.

## Freeze and review boundary

`freeze.json` SHA-256:

`bc4491bb7179f893df864a4ebfab5c5175670f9b368705dc8cf0ae878c7a27cd`

150-question expectation SHA-256:

`236131aa49aa5b7b31c8b07e7fe192b4cdee54f7ed723fb630349c8951d86bb0`

The algorithm implementation side receives group names, counts, schemas and hashes. New queries and expected answers remain blind until the retrieval algorithm is frozen and the prior calibration run is complete. Old data, old expectations and the nine-failure diagnosis remain unchanged.

The retrieval environment combines these 121 originals with all earlier 107 originals: **228 PDFs / 2,935 pages**, without group-filtering candidates for the new queries. The prior documents remain legitimate distractors and their complete parsed versions are reused. The isolated parse-only run has finished successfully: 228 originals and 2,935 actual pages are ready, with zero parsing errors. This establishes complete ingestion, not query accuracy.

## Retrieval acceptance scope and provenance

`scripts/benchmark-pdf-heldout.mjs` accepts `PDF_HELDOUT_GROUPS=ml6867,algorithms6046,systems6004`, the fresh `PDF_HELDOUT_DIR`, and `PDF_DISTRACTOR_DIR` pointing to the earlier 107-original bundle. It validates bytes, hashes and actual page counts for both bundles. `--group` selects questions only; it never narrows retrieval candidates. `--hybrid` and `--ai-rerank` are explicit opt-ins; this preparation does not invoke them.

Each returned hit must match a frozen original identity, a page within that original's range, the owner's current PostgreSQL source version and that exact page's evidence ID. This metadata is rechecked after each query; a stale version or foreign evidence fails the provenance gate. Expected-page accuracy is checked separately. The report preserves errors, fallbacks, degraded components and failed questions.

`algorithmFreeze` records SHA-256 hashes of the actual library and kernel source files loaded at process start; source changes during the run fail the gate. `PDF_CODE_BASELINE` may additionally label the release commit but does not replace the source digest. Reports distinguish a selected-group result from `completeThreeGroupGate`, which requires all three groups. Each group and entry point requires at least 95% top-five original-page recall across all 50 questions, zero errors/fallbacks/degradation/provenance failures, and complete corpus coverage. No expected location is adjusted in response to retrieval.

## Preparation commands

`scripts/prepare-pdf-fresh.mjs` uses no application service, database or AI import. It supports `--discover`, `--download`, `--extract`, `--freeze` and `--validate`. Download selection is the ignored `source-selection.json`; manually authored source-based questions are the ignored per-group `question-drafts.json`.

`PDF_FRESH_DIR` overrides the asset directory; `PDF_PREP_PYTHON` supplies an existing Python runtime with pypdf. The default is the bundled Windows runtime. Validation checks original bytes, original-reference source hashes/page manifests, exact evidence anchors, distinct question counts, document coverage and immutable frozen output. It refuses to overwrite a changed existing gold file.

## Delivery status

- **Code complete:** corpus preparation and the bounded acceptance runner changes are ready for PR #54 review. Application search implementation belongs to the separate kernel work.
- **Tests:** source-integrity checks and isolated full ingestion passed; the fresh three-group retrieval gate is pending. No accuracy percentage is claimed here.
- **Services deployed:** these preparation/acceptance changes have not been deployed to the production application. Running the isolated evaluation container is not production deployment.
- **Production switched:** no production cutover is established by this work.
