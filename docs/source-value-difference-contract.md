# Selected-source values and explicit differences (Issue 185)

`STUDY_SOURCE_VALUES=off|difference-v1` is server configuration and defaults to
`off`. Enabling requires the Kernel backend, application policy,
`select-then-answer` and `selected-once` original-image checks. No model stage,
revision loop, parser, index or canonical fact is added.

## Scope of the changed contract

The selector and its original request are unchanged. On the explicit new
contract only, `resolveSourceValueEvidenceSelection` treats legal suggestions
as an exact set and retains the original image IDs of available bound table
observations already in the prepared context. It reads no new source or image.
Original suggestions must still contain at most 64 legal string IDs; unknown
IDs, extra fields and malformed arrays reject before deduplication. More than
64 effective references after retention reject without discarding sources.
The old strict validator/default-off path still rejects duplicates.

The receipt separates `providerReferenceIds` (including repetitions),
`normalizedProviderReferenceIds`, `systemRetainedReferenceIds`, effective
`referenceIds` and `retentionPolicy=source-value-retain-bound-table-images-v1`.
System additions are never reported as provider-selected images. Empty advice
with a bound available table may proceed with that original image; empty advice
without one keeps the existing neutral insufficient-evidence path. Unavailable
observations are not promoted. Retention is not a relevance, content or
semantic certificate and does not add an image citation to a statement.

Only this effective original-evidence generator may use
`prepareSelectedSourceValueGeneration`. Its complete cell
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

### Explicit absolute-difference questions

`sourceValueQuestionContract(question)` is a conservative pure intent gate.
Explicit numerical/absolute differences or how much a result outperforms or
improves another can select `required-difference-v1`. Relative percentages,
ratios, folds, averages/sums, methodological explanations and unrecognized
wording keep `mixed-v1`. Percentage points are an absolute-difference cue, not
a request for relative growth. This is fallible routing, not semantic proof;
it reads no source values, titles, IDs or expected answers. The actual builder
also keeps mixed mode when selected originals span multiple source identities
or the catalog contains multiple tables. It cannot force a cross-source
question into the existing same-table operation.

Only the bounded, applicable new route changes the generator schema to a
strict root `{result: ...}` union. `answered` requires nonempty `comparisons`
of the existing ID-only differences; ordinary `statements` stay separate with
their own unchanged references. Insufficient and conflicting results remain
available. The program normalizes comparisons first, then statements, without
changing statement text or adding their citations. Each array is bounded at
30 in the schema; the combined 30-claim limit is an explicit decoder business
constraint (like the same-table/column constraint), with a clear error rather
than truncation or automatic retry. The builder returns its actual `questionContract` (or null when
unapplied); the decoder's optional fifth parameter defaults to `mixed-v1` and
never auto-detects the new shape. Old mixed schema, wire and default decoding
stay unchanged. The new contract name is separately recorded in the actual
request, raw-response receipt, derivation and application result metadata.
Neither old statements nor an old failed response can be promoted to an
operation. No extra model stage, source read, unit inference or review is added.

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
The two additional retention targets use a component prepared context. They do
not replay the full original 35b packet or claim that the previously failed
question has now succeeded; the original six-ID failed run remains unchanged.
Its real full-packet offline check is separate from these committed targets.
Two new required-difference targets cover conservative routing/source bounds,
closed-schema decoding, unchanged statements/refusals, preservation of the
frozen historical raw, and raw-first mocked synthesis. Their constructed
operations verify a contract and fixed-point calculation, not that any model
selected the right comparison or that an exposed question now passes.
Local targeted checks mock all model transport and do not write PostgreSQL or
claim fresh-current validation. No previous score or independent cohort changes.
