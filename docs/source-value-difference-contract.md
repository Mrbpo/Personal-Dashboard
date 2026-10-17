# Selected-source values and explicit differences (Issue 185)

`STUDY_SOURCE_VALUES=off|difference-v1` is server configuration and defaults to
`off`. Enabling requires the Kernel backend, application policy,
`select-then-answer` and `selected-once` original-image checks. No model stage,
revision loop, parser, index or canonical fact is added.

## Scope of the changed contract

The selector and its original request are unchanged. Only the actually selected
generator may use `prepareSelectedSourceValueGeneration`. Its complete cell
catalog uses the existing current original-PNG observations: author
`visible_table_grid_v1` and Docling native tables retain their own identities.
Cell IDs bind the source/version, evidence, PNG, attachment, candidate artifact,
table, original cell text/position/span/role and declaration hashes. This is
mechanical binding to fallible declarations, not a new visibility or semantic
certificate. Native missing header flags stay unknown, not invented roles.

Whole tables are used, never a truncated prefix. Above 256 cells, 32 KiB of
complete catalog UTF-8, unavailable observations, no observed tables, or the
existing 300k actual request input bound, the original selected generation is
retained with `newContractApplied=false` and a reason. The actual new request
bound includes its new schema/catalog/prompt, non-image UTF-8, the existing
framing allowance and only the actual selected images' token accounting.
The ordinary text and multi-source route is not narrowed or silently replaced.

New responses contain atomic typed claims:

- `statement`: original model text and selected original reference IDs. The
  server does not add a table/image reference to a statement.
- `difference`: only `leftValueRef`, `rightValueRef`, `leftRowLabelRef`,
  `rightRowLabelRef`, and 1–4 `columnLabelRefs`. No result, units, free assertion
  or citation ID is accepted on this operation.

A difference requires two explicit plain decimal, single-slot values from the
same source table and numeric column, explicit nonblank positioned row labels
and nonblank column/section labels covering that column above both values.
Header spans and role declarations are checked as positions, not interpreted
as a verified parent hierarchy. Only explicitly selected original header texts
are displayed, including a section text if selected; no extra unit is inferred.
Missing values, dashes, commas, scientific notation and unit-bearing value
strings do not become numbers or zero. Fixed-point BigInt subtraction preserves
the printed scale without percentage/percentage-point or other conversion.
The renderer states the original labels, both original values and the
left-minus-right printed-value difference, citing their original PNG.
Whether the requested comparison, source roles, table declarations or meaning
are correct still needs the original-image audit and independent review.

## Raw versus program output

For an applied contract, `providerSelections` is **null**. The actual model
operation object/text and hashes are retained separately in
`sourceValueDerivation`, alongside program-normalized selections, normalized
answer, operation/operand traces and the unchanged false semantic/relationship/
visibility flags. The receipt binds actual generation request SHA, original
source-input fingerprint, quote manifest, catalog and actual selected IDs.
The service explicitly sends these program-generated claims to the existing
selected-only audit; that audit sees only the actual original selected PNG or
text units. AST/catalog values cannot rescue a wrongly cited statement.

The existing private `STUDY_CITATION_TRACE_DIR` recorder uses one run ID and
`wx`/fsync files. Before parsing or deriving the new response it saves
`<runId>-<requestSHA>.source-values.raw-response.json`. After generation and
current-source recheck it separately saves
`<runId>-<requestSHA>.source-values.json`, before local checks. Invalid JSON,
operations or source drift therefore retain the original response; recorder
failure prevents publishing. Both durable callbacks are required before any
source-value synthesis attempt; pure request builders require no file callback.
There is no new journal or HTTP call. Application
metadata reports `answerContract` and per-claim origins: provider statement or
program-rendered difference, without relabeling mixed answers as all generated
by the program. Old raw responses are never converted into new operations.

## Verification limits

The frozen exposed author's actual generation request
`dfd8a9954b2f33118bcf05cbf65c04369a2cdab7619cd45b7e80c6df1ab744eb`
supplies the existing original PNG, AST and old raw fixture. The pure 0.14
check verifies an operation/arithmetical construction, not that a model chose
the comparison or that the original question/answer passed. The old wrong
free-claim result is retained and rejected as the new typed protocol.
Native fixture coverage reuses saved parser output without new conversion.
Local targeted checks mock all model transport and do not write PostgreSQL or
claim fresh-current validation. No previous score or independent cohort changes.
