# Selected document titles in Kernel search

Refs #68. A visible client title is source metadata, separate from the original
relevance query. This interface does not infer a document from answer gold.

```ts
const sourceHint = {selectedDocumentTitle: 'Finite field guide'};
const resolution = await kernel.resolveDocumentSource(owner, sourceHint, {courseId});
const hits = await kernel.searchDocumentText(owner, originalQuestion, {
  sourceHint, courseId, limit: 14, hybrid: false, semantic: false, aiRerank: false,
});
```

`DocumentSourceHint` is a typed object. The explicit resolver returns
`resolved`, `not-found`, or `ambiguous`. It compares complete titles after NFKC
normalization, preserving case, punctuation, and whitespace. It does not infer
aliases or strip filename suffixes. Only current parsed documents belonging to
the requested owner/course, visible and newest for their origin identity, are
eligible. Two eligible matches establish ambiguity; sorting never picks one.

Search accepts only a unique resolved source, converts that visible selection to
an internal document ID, and passes `originalQuestion` unchanged into existing
ranking. Returned hits carry `retrieval_scope: 'selected-title-scoped'`. The
resolver checks the source again before publishing hits; a changed identity or
current version fails explicitly. No hint preserves existing global behavior.

`DocumentSourceResolutionError` has a stable `code`, a scope, and the resolver
result when available:

| Code | Meaning |
| --- | --- |
| `DOCUMENT_SOURCE_INVALID_HINT` | Missing, empty, or oversized title |
| `DOCUMENT_SOURCE_NOT_FOUND` | No current visible title match in this scope |
| `DOCUMENT_SOURCE_AMBIGUOUS` | Multiple distinct current title matches |
| `DOCUMENT_SOURCE_SCOPE_CONFLICT` | An explicit document ID conflicts with the selected title |
| `DOCUMENT_SOURCE_CHANGED` | Visibility, uniqueness, identity, or version changed during retrieval |

Failed resolution never falls back to global search. Not-found does not disclose
whether a source belongs to another owner, is hidden, or has been superseded.
Ambiguous results include at most two eligible sources, sufficient to establish
the conflict without scanning/exporting corpus bodies.

This corrects mixing source-title words into question relevance. It does not
establish complete author-evidence recall or answer correctness. A diagnostic
using this hint is selected-title-scoped QA; it cannot be reported as global
cross-material 100% acceptance. The original A protocol/report remain frozen;
any later query-only A diagnostic needs its own protocol and core hashes.

## Focused verification

Five synthetic PG tests passed in the separate `source_hint_20261014_test` schema
of the existing isolated `pdf_acceptance_20261006` database. They cover owner,
course, hidden and superseded sources, equal-time origin identity, NFKC ambiguity,
normal source/query separation, and a source hidden while its query is in flight.
External fetch is blocked and asserted unused. The real 181-paper A corpus was
neither reingested nor queried by these tests. The first fixture attempt lacked
its new schema and failed before creating fixtures; isolated bootstrap corrected
the setup. `tsc --noEmit --incremental false` and `git diff --check` also passed.
