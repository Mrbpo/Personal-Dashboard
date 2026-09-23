# Vector retrieval options (2026-09-23)

## Baseline and limits

Production aggregates from the preceding read-only audit: `library_vectors` held 4,346 rows and 62,399,924 JSON bytes. After the separate mail backfill, `mail_embeddings` held 1,524 current-version rows and 21,905,459 JSON bytes; 338 active mails still had no vector. `tutor_memory_vectors` and archived-mail version vectors had no production rows in that audit. These are payload bytes, not SQLite file size. No message body, vector, identifier, or credential was copied into this study.

Current library search first applies owner/course and FTS or keyword candidates, then reads vectors only for those candidates. The earlier full-library read has already been fixed. The audit saw 2–34 vectors (28,696–488,447 bytes) on ordinary scoped queries and 256 vectors (3,681,491 bytes) on a zero-lexical-hit fallback. Those are database-local read counts, not end-to-end API latency. Query embeddings are requested only when semantic search is invoked. Structured Canvas/Piazza content has its own FTS path and is not covered by vector-only tuning.

## Reproducible local comparison

Run `node --experimental-strip-types scripts/benchmark-vector-options.ts` after `npm ci`. It uses only a transient synthetic SQLite database and never calls an embedding API. Its hand-labeled five-document fixture has two queries and four relevant document labels. Exact FTS finds two of four labels (Recall@5 = 0.50); scanning all five would include four of four. This illustrates synonym misses in a tiny artificial corpus, **not** real retrieval recall or a measured semantic-model gain. There is no user-question relevance set yet.

The 500-mail synthetic overlap experiment fetched 300 recent and 400 lexical candidates, with 250 shared IDs. Existing code read 700 vector rows / 11,349,800 bytes; deduplicated code read 450 / 7,296,300 bytes: 35.7% fewer bytes and identical candidate IDs. Nine alternating runs had ~37 ms median on both paths in one local run. Wall-clock improvement is not established; no production change is implied by the synthetic timing.

| Option | Expected benefit | Retrieval risk / work | Recommendation |
| --- | --- | --- | --- |
| FTS + scoped vector ranking | Current bounded reads; no new storage; good exact-term precision | FTS misses synonyms; 256 fallback only happens with zero lexical hits. Candidate cap can exclude old relevant material. | Retain; evaluate multi-query aliases / reciprocal-rank fusion against labeled questions before changing limits. |
| Deduplicate overlapping mail candidates | Exact same candidate/vector set, 35.7% lower vector bytes in the synthetic 250-overlap case | Negligible code change; concurrent mail update between the two reads can still cause snapshot differences | Implemented in this branch. |
| Shared vector by content hash | Audit found 716 duplicate library rows / 10,284,563 JSON bytes; up to 716 embedding calls avoided if shared before generation | Need owner + model + input-version key, reference lifecycle, concurrent insertion, and immutable content proof | Next storage/ingestion experiment; not a retrieval speed fix by itself. |
| Float32 BLOB instead of JSON | At 768 dimensions, 3,072 bytes/vector. Library theoretical saving 49,049,012 bytes; mail saving 17,223,731 bytes at audited counts. Together ~66.27 MB logical payload. | Dual-read/write migration, dimension/endian validation, exact top-k parity, backup and rollback. Float32 rounding may perturb near-ties. | Worth isolated migration and top-k comparison; do not flip production schema without recall validation. |
| Two-stage ranking / RRF | Can combine FTS/BM25, recency, and semantic evidence; may recover relevant older items | Candidate generation determines recall; reranking only surviving candidates cannot recover excluded documents. Extra model reranker adds cost and latency. | First build 30–50 labeled real queries with known source IDs; compare Recall@8, MRR, bytes, p50/p95. |
| Tutor-memory shortlist | Potentially avoids reading up to 20,000 course-scoped message vectors | Audit had zero production memory vectors; lexical shortlist can lose paraphrases. | Defer until the feature has real data and relevance labels; then test a hybrid recent + lexical shortlist. |
| HNSW / SQLite vector extension | Could avoid exact cosine over a much larger corpus | Additional native extension/deployment compatibility and index maintenance; ANN can lose recall. At 4,346 library vectors, current candidate reads are small and query embedding likely dominates. | Defer. Reconsider when scoped fallback routinely reads thousands of vectors or p95 measurements justify it. |

## Acceptance gates for further changes

Use a private, redacted evaluation set with query, course, and expected source IDs; store no mail or course body in test output. Compare Recall@8 and MRR against the current deployment, with category slices for synonyms, old documents, Piazza-linked answers, and mail. Record candidate count, vector rows/bytes, p50/p95 DB time, embedding time, total request time, and paid API usage. Run same-version before/after tests. Block a rollout if any critical labeled answer disappears, unless its underlying document is unavailable. Production audit should remain read-only and bounded.
