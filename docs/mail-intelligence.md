# Incremental email intelligence

The Gmail connection remains read-only. Provider data is normalized into `mail_messages`; derived results are stored separately in `mail_intelligence`, `mail_embeddings`, memory/profile tables, and append-only `mail_feedback` records.

## Processing

1. Gmail history/page cursors import only new or changed messages. Upserts are idempotent.
2. Local signals create a free, versioned baseline and update bounded sender/pattern statistics.
3. On-demand or nightly analysis builds a token-bounded context from the current thread, sender profile, recurring patterns, and relevant corrections.
4. The configured model must return strict structured JSON. Zod validates it before any derived state is updated.
5. A successful analysis updates entity memory and a 768-dimensional semantic index. Failures remain retryable in `mail_processing`.
6. User corrections preserve both the prediction and correction in `mail_feedback`. Category and importance corrections update future sender context without fine-tuning.

## Shared mail and library retrieval

Newly archived email bodies keep their full text in `library_chunks` for keyword search, previews, and citations. `library_mail_sources` records the source account, message, and content hash. Their semantic search uses the same one-per-message `mail_embeddings` vector as related-mail search; `embedMissing` does not embed each body chunk. It also creates that vector for an archived message that has not received AI analysis. Attachments remain separate library documents with their own chunk vectors.

The mail vector contains the subject and up to 6,000 body characters. Long bodies contribute excerpts from the beginning, middle, and end. Exact lexical retrieval searches the complete stored body, including text outside those excerpts. Related-mail search selects rare terms across all parts of the body, uses a subject/body FTS5 index to find at most 1,200 account-scoped candidates, then ranks at most 400 lexical candidates. Its semantic pool is limited to those candidates plus 300 recent account-scoped vectors. A SQL fallback remains available where FTS5 is unavailable.

Archives created before `library_mail_sources` keep their existing chunk vectors. They are not automatically mapped to the current email, because the archived body may predate a Gmail content update. Newly archived versions use the shared vector. When Gmail content changes, an old vector is retained only if a live archive references that exact source hash; nightly garbage collection removes historical vectors without a live archive. For a semantic-only hit on an archived email, search returns a document-level result marked "段落未定位" instead of citing an arbitrary chunk.

The regression fixture in `tests/mail-vectorization.test.ts` archives roughly 30,000 characters: 22 searchable body chunks produce one mail embedding input and zero body chunk vectors. It checks a unique fact near the first quarter, a tail fact, 1,500 newer boilerplate emails, semantic-only location labeling, attachments, content updates, legacy archives, cleanup, and owner isolation. The checked-in local database contains no email rows, so this is fixture evidence rather than a production measurement.

Night processing keeps scheduling internal batches until every eligible message is handled; the batch size is only queue back-pressure, not a nightly total limit. The existing monthly AI budget remains the spending safety boundary. It prioritizes unanalysed, non-junk messages and outdated analysis versions. It never overwrites raw mail or a manual category.

## Reused components and external references

- Existing `background_jobs`, `paidOpenAI`, `library` embedding model/cosine search, Gmail history cursor, thread summaries, and confirmed schedule flow are reused.
- [`postal-mime`](https://github.com/postalsys/postal-mime) (MIT-0) supplies RFC-aware address parsing and encoded-word decoding.
- The correction ledger and original-prediction retention follow the safety pattern demonstrated by [JevMail](https://github.com/fazlerocks/jevmail).
- Rules, analytics, and bounded automation were informed by [Inbox Zero](https://github.com/elie222/inbox-zero), but no AGPL application code is copied.
- Thread-aware UI and schema-first settings were informed by [Mail-0/Zero](https://github.com/Mail-0/Zero), without importing its application architecture.

## Reprocessing API

`POST /api/mail` with `action: "reprocess"` supports one email (`id`), one thread (`threadId`), a date range (`from`/`to`), or analyses from an older schema (`outdated: true`). It reuses stored raw mail and never downloads it again.
