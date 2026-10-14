# Current evidence-node selection

`KernelService.readDocumentNodes(owner, expectedSource, evidenceIds)` reads 1–14
distinct original node IDs selected by a query planner. `expectedSource` binds
the document ID, current document version, source-item version, original source
hash and optional course constraint. Empty/duplicate selections are invalid;
foreign, historical, hidden, superseded-origin or changed-source selections fail
without partial results or a fallback.

The reader first associates every ID with the current owner/source/evidence
chain, then reuses `readFullDocumentEvidence` to obtain actual PostgreSQL bodies
and parser warnings. It preserves requested ID order and verifies the hydrated
version against the expected current version. No body or metadata is accepted
from the caller. IDs are `pg:<document-version>:<physical/stored-node-ordinal>`;
locators and original evidence IDs remain unchanged. Full-page means complete
stored text, subject to the existing transcription warnings.

Results use `DocumentSelectedNodeHit`, a separate unranked variant:
`reader_selection: 'evidence-node-ids'`, `retrieval_mode: 'reader-selection'`,
`evidence_body: 'full-page'`. They have **no score or rerank fields** and are never
labelled keyword or AI-ranked results. Ranked search retains its existing
`DocumentTextHit` type and numeric score. `DocumentEvidenceHit` permits these
selected nodes in the existing full-body reader, parent-context reader and
grounded-answer preparation without changing ranking algorithms or anchor
counts. Planner selection is not retrieval/answer accuracy evidence by itself.

This is a read-only application module, with no UI, migration or model call.
The focused PostgreSQL test covers actual long body/order/provenance, consumer
compatibility, invalid IDs, owner/course/source isolation, historical IDs and a
source hidden between metadata selection and full-body hydration. Existing
context/answer tests are not duplicated locally; final CI remains required.
