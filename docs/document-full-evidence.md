# Full document evidence

Refs #68. Search normally returns a matching chunk, at most about 1,600 characters.
That preview can omit evidence later in the same stored paragraph or PDF page.

```ts
const hits = await kernel.searchDocumentText(owner, originalQuestion, {
  limit: 14, evidenceBody: 'full-page',
});
```

This opt-in returns the complete stored page body after existing ranking finishes.
It preserves the query, candidate pool, final limit, order, scores, provenance and
retrieval mode. It does not add an expected document, expand a hit list, or change
the default snippet response. It also works with a separately selected title.

Each full body is read through current owner, course, visibility, origin identity,
source hash, source version, parser version and evidence ID checks. If any result
has changed, the whole request throws `DocumentEvidenceChangedError` with code
`DOCUMENT_EVIDENCE_CHANGED`; stale snippets are not substituted. Callers may make
a fresh search. A full body uses the page ID rather than a preview chunk ID.

`evidence_body: 'full-page'` means complete **stored** text. Existing parser
warnings remain present: this flag does not certify OCR, equations, missing
figures or source-document transcription fidelity. No UI or ingestion behavior
changes, and no external model request is added by reading full evidence.

## Verification

Three focused tests passed against PostgreSQL in the separate
`full_evidence_20261014_test` schema of `pdf_acceptance_20261006`: a long stored
paragraph with evidence beyond its preview, a source hidden before the full-body
read, and invalid option rejection. The full response retains original parser
warnings and the same ranked evidence; a foreign owner cannot hydrate it.
External fetch is blocked and asserted unused. TypeScript checking passed.
This fixture result does not establish real-cohort retrieval or answer accuracy.
