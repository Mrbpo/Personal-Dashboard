# Cross-document reference recall (Issue #68)

This change adds an opt-in `relatedDocuments` search option to the existing in-process KernelService. It changes neither UI nor the authoritative fact model. Document titles and mentions are retrieval hints, never instructions or canonical identity merges.

The current query first uses the existing PostgreSQL keyword search. Two bounded metadata/mention lookups can then retrieve a question-named document and a document referenced by up to four candidate sources. Filename extensions, final disambiguators, and numbered identifiers provide aliases while each document, owner, course, current source version and evidence remain distinct. Single-word names require an explicit capitalization/quotation hint; CJK names and identifiers do not require letter case. Normal lowercase words must not automatically promote a same-named document.

The result retains the requested upper limit. No gold IDs, dataset names, answer strings, or question-specific rules are used by the retrieval implementation. Strict and explicit-document searches retain their existing path. The feature is disabled unless the caller opts in; hybrid/AI behavior needs separate verification before enabling it in an application route.

## Actual calibration evidence

- Base image: `ea57f9bc173de5a771e8fc8e1dd6b1a2fab092fb`, plus explicitly fingerprinted draft core code.
- Existing isolated PostgreSQL database/schema: `pdf_acceptance_20261006` / `text_calibration_20261014_baseline`. The query connection is read-only. No repeated ingestion or Truth fixture creation.
- Original frozen input: 9,769 complete cached text documents. Manifest SHA256 `a72417248fde61064aa78381a6ad002fe1c49c15ce4bb71bc8edd9efb8e380f4`.
- Original 50 Hotpot questions, unchanged gold and limit 14: base **35/50** full-source recall. Initial reference recall **48/50**, with 14 improvements and one regression. All returned evidence passed current owner/course/source/version checks, and document/code fingerprints remained unchanged during that run. No network or paid AI calls.
- The initial run took 219.709 seconds; median query time 4,272 ms and p95 5,601 ms in a one-CPU container. This is measured calibration latency, not a production performance promise.
- A general single-word-name correction resolved the two remaining diagnostic cases in actual PostgreSQL. Complete revalidation then reached **50/50**, with 15 improvements over baseline and no regressions. Current owner/course/source/evidence checks passed 50/50 and pre/post code and corpus fingerprints were unchanged. The run took 236.538 seconds; median 4,556.835 ms and p95 6,250.836 ms. Private reports `related-pass-1.json` and `related-pass-2.json` preserve both intermediate and final results.
- The complete run used reference-helper SHA256 `aa7fb14e68b043af1c4c7d4a43ed3d9f3cfc2a1048cf31b53e77d838323aad92` and corpus fingerprint `62b7dfc9195706dbea7da17b067a1df17de9fc52c5c233483c0d72878139f794`. A subsequent payload reduction sends only evidence identities to the final PostgreSQL recheck; it does not alter the selection rule. Formal algorithm freezing must use the final complete code fingerprint.
- A subsequent exact-token prefilter avoids expensive whole-phrase checks when the first alias token is absent. It is a necessary condition for the existing phrase match; reverse seed-name containment stays unchanged. A single-query latency diagnostic returned identical evidence identities and took 3,675.960 ms versus 4,166.963 ms before it. This sample is not a new full accuracy or latency benchmark. Background Docling was using approximately 3.5 CPU cores on the four-core shared host; production settings were not changed. Disabling JIT in the isolated session brought no useful gain and was not adopted.
- Focused PostgreSQL checks passed 3/3 without skips. Local type check and targeted lint passed. Private raw reports remain in ignored data directories and on the isolated server.

Natural-language answer evaluation remains pending. These known-question calibration runs are not the requested three unseen, distinct 100% acceptance states. The 100% streak remains zero; no new algorithm release or production switch is established by this work.

## Remaining gates

1. Check every original question after a substantive selection change and preserve all regressions.
2. Freeze algorithm, model/configuration and source/evidence fingerprints before formal acceptance.
3. Run three distinct, previously unseen study-oriented material/question sets. Exercise ingestion increments, restart recovery, and rebuilding in their respective states without replacing the question/source diversity with cache variation alone.
4. Count retrieval, canonical Truth correctness, complete grounded answers and applicable citations separately. Any failed case prevents a 100% state and resets the consecutive streak.
5. After three successes, increase independently obtained public learning material/noise and rerun the fixed checks. Deterministic operations and evidence integrity must remain correct.

Missing results are pending, never successful by assumption. Administrator-tool merges, CI, Compose files and calibration scores do not establish production deployment.
