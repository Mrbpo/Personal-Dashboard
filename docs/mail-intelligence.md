# Incremental email intelligence

The Gmail connection remains read-only. Provider data is normalized into `mail_messages`; derived results are stored separately in `mail_intelligence`, `mail_embeddings`, memory/profile tables, and append-only `mail_feedback` records.

## Processing

1. Gmail history/page cursors import only new or changed messages. Upserts are idempotent.
2. Local signals create a free, versioned baseline and update bounded sender/pattern statistics.
3. On-demand or nightly analysis builds a token-bounded context from the current thread, sender profile, recurring patterns, and relevant corrections.
4. The configured model must return strict structured JSON. Zod validates it before any derived state is updated.
5. A successful analysis updates entity memory and a 768-dimensional semantic index. Failures remain retryable in `mail_processing`.
6. User corrections preserve both the prediction and correction in `mail_feedback`. Category and importance corrections update future sender context without fine-tuning.

Night processing keeps scheduling internal batches until every eligible message is handled; the batch size is only queue back-pressure, not a nightly total limit. The existing monthly AI budget remains the spending safety boundary. It prioritizes unanalysed, non-junk messages and outdated analysis versions. It never overwrites raw mail or a manual category.

## Reused components and external references

- Existing `background_jobs`, `paidOpenAI`, `library` embedding model/cosine search, Gmail history cursor, thread summaries, and confirmed schedule flow are reused.
- [`postal-mime`](https://github.com/postalsys/postal-mime) (MIT-0) supplies RFC-aware address parsing and encoded-word decoding.
- The correction ledger and original-prediction retention follow the safety pattern demonstrated by [JevMail](https://github.com/fazlerocks/jevmail).
- Rules, analytics, and bounded automation were informed by [Inbox Zero](https://github.com/elie222/inbox-zero), but no AGPL application code is copied.
- Thread-aware UI and schema-first settings were informed by [Mail-0/Zero](https://github.com/Mail-0/Zero), without importing its application architecture.

## Reprocessing API

`POST /api/mail` with `action: "reprocess"` supports one email (`id`), one thread (`threadId`), a date range (`from`/`to`), or analyses from an older schema (`outdated: true`). It reuses stored raw mail and never downloads it again.
