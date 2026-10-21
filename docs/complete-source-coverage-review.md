# Complete-source answer review (development, Issue #171)

This optional lane is disabled by default. `PlannedStudyAnswerPolicy.completeSourceReview`
accepts `diagnostic` or `one-content-revision`, only with a verified complete single-source
evidence route. It is mutually exclusive with `citationRevision`. Ranked/multi-source
answering, existing local audit behavior and historical v7–v9 transports are unchanged.

## Reuse an existing answer

`reviewCompletePlannedStudyAnswer(question, readPacket, artifact, policy)` does not
regenerate the baseline. `readPacket` must reconstruct the current Kernel generation
packet; archived request JSON is not a source reader. The artifact contains the original
receipt, canonical selections, actual SourceN transport and original HTTP response.
Optional `originalLocalAudits` contain each actual selected-only result and its raw HTTP
response. The utility rebuilds their claim/source bindings, wires and request identities,
checks raw hashes, completed model/usage and parsed diagnostics, and rejects changed data.
The integrated answer entry captures those already executed raw responses automatically;
it does not repeat original local checks.

The original complete-source manifest, current versions, question contract, canonical
fingerprint, quote manifest, every selectable q/i unit and original image are retained
and reread around every new request. Parser warnings remain present. Complete source
means coverage of current stored/parsed evidence; it does not certify PDF fidelity or
that the question has been fully answered.

## Two distinct diagnostic inputs

The new full-source diagnostic examines question coverage, subject/scope and evidence
roles. Concrete issues require actual supplied source IDs and fixed requirement IDs or
an exact original-question span. `uncertain` is not an established issue, and
`no-specific-gap-found` is not a completeness certificate. This diagnostic has no
`localSupport` field and does not receive existing local verdicts.

Original selected-only findings remain separate and raw-bound. Explicit `unsupported`
may trigger a content proposal even when the full-source diagnostic reports no concrete
issue. It means the original selected references did not establish the claim, not that
the full source proves the claim false. Neither diagnostic can rescue a wrong citation
using unselected text or an unrelated table.

## One separately recorded proposal

With `one-content-revision`, concrete full-source issues **or** original explicit local
unsupported findings permit one new content proposal. It receives the original answer,
the two separate fallible diagnostic inputs and all original evidence. It cannot replace
the question contract, add source IDs or shrink evidence. The proposal uses the existing
SourceN schema and true canonical selector validation. More than six claims is retained
as `capacity-exceeded` without truncation or further audits.

Every revised claim receives a new physically selected-only audit. Original diagnostics
are never relabeled as review of the revised candidate. The original answer remains the
primary result; the proposal is a separate `revised-awaiting-independent-review` branch.
All semantic/whole-answer verified flags remain false; question/full-source/conflict
coverage remains unassessed. Failures stop without retry, retain the original state and
actual raw response, and do not silently apply a partial revision or suppress source drift.

## Request and validation scope

There is at most one review (mini54 low/4000), one proposal (mini54 medium/4000), and
K new local checks (mini54 low/1000, 0≤K≤6): at most eight additional requests. Diagnostic
mode uses only the first request. Existing generation stays medium/4000. Actual complete
body/image/schema bounds, ordinary reservation and usage bounds, mandatory pre-request
and raw-response journals, and caller funding limits apply separately to each phase.
There is no retry, planner, model upgrade or new deployment/API route. An exported utility
is not authorization to send a paid request.

### Explicit reasoned evidence profile (Issue177)

Development callers may pass `auditProfile: 'reasoned-v1'` through
`KernelService.auditSelectedStudySourceClaim`, `KernelService.answerPlannedStudyContent`
or `reviewCompletePlannedStudyAnswer`. Only new citation-local and complete-source
coverage requests then use fixed `gpt-5.4-mini`, medium reasoning, 4000 output tokens
and the existing 30s timeout. Prompts, schemas, original text, source IDs, PNG bytes,
image detail, current-source checks and single-attempt boundaries are unchanged.
Generation/content revision keeps its existing medium/4000 settings. Without this
explicit profile the old local low/1000 and coverage low/4000 bodies and identities
remain byte-compatible. The profile is bound to the new actual request identity and
diagnostic/attempt metadata; actual-body reservation and usage bounds include 4000
tokens for every new local check. There is no extra request or automatic upgrade.

An archived original audit is restored using its own recorded profile (absent for
historical low/1000), original request/raw identity and source binding. The new profile
does not relabel, regenerate or re-audit it. Newly proposed content receives separate
medium/4000 selected-only checks. Original selected-only failures remain separate from
full-source coverage; neither can be washed away by an unrelated source. Combining
this profile with `citationRevision: true` is rejected before source/provider work:
the older citation-only proposal/final-audit protocol stays unchanged. Unknown profiles
and medium coverage without the exact explicit profile fail before reservation.
Production settings remain restricted to their existing defaults.

These execution and mock compatibility checks do not prove better semantic accuracy,
complete answers, correct PDF transcription or any independent benchmark pass. Actual
paid validation and deployment require their separate coordinator authorization.

Focused mock checks cover real-ID validation; uncertain/refusal handling; preservation
of original raw, all source text/images and unchanged facts; physically local re-audits;
tampered raw/diagnostics, source drift, invalid selectors and capacity; integrated capture
of existing local raw; and the independent unsupported trigger. Existing deterministic
route, historical transport and ranked short-chain checks were also run selectively.
No real provider, PostgreSQL, new PDF parse, deployment or production switch was used.
Structural/mock success does not establish complete-answer accuracy or three independent
acceptance groups; the coordinator controls later real diagnostic pilots.

### Explicit question-scope ID bindings (Issue181)

`scopeWitnessPolicy: 'question-scope-v1'` opts the existing coverage/revision
exchange into `complete-study-scope-id-bindings-v2` and
`complete-study-scope-id-revision-v2`. It still requires explicit
`completeSourceReview` and rejects `citationRevision`. No model, phase, output
allowance, contract-v1 field or database table is added. Absent this policy,
the previous default request bytes, identities and behavior remain unchanged.
The independent `auditProfile` still controls only its existing execution settings.

The request freezes a `scopeBindingRegistry` and its SHA from the actual question
contract: each rN has an `rN.aspect`, plus IDs such as `rN.configuration` for its
non-null scope fields. Their original strings are supplied by the program; the
model does not retype question spans, source quotes, labels or qualifications.
The full original question remains present. The contract and its aspect registry
are fallible: a qualification absent from the contract remains part of the user's
question, and this registry cannot prove question completeness.

Each rN returns `findings` with only `aspectIds`, actual `sourceIds`, original
`claimIds` and a fallible `supports`/`contradicts`/`unclear` judgment. Issues similarly
select aspect IDs; the program preserves them and derives their parent rN IDs.
Sources and aspects use shared schema enums; the final serialized coverage and
revision schemas are checked before reservation against the existing 1000 enum,
15000 per-enum string (when over 250 values) and 120000 total string limits.
No source is truncated to satisfy capacity. Unknown IDs, wrong requirement/aspect
bindings, duplicate IDs and stale registry identities fail, retaining the raw.
Binding arrays are bounded at 30; source/aspect arrays require at least one ID.
Each rN gets a uniform `floor(30 / requirementCount)` findings allowance in both
schema and validator, keeping the whole response within the existing 30-finding
limit. This is an output capacity bound, never a count of real entities. Cases
that do not fit must remain incomplete rather than claim exhaustive coverage.

After the existing fresh Kernel source/answer checks, the program restores each
selected original paragraph or image with its actual caption members and source
identity. A valid but irrelevant source ID stays that exact source: there is no
quote search, neighboring-source substitution or automatic citation addition.
`bindingsValid: true` certifies this mechanical restoration only;
`semanticVerified: false`, `questionCoverage: 'unassessed'` and the separate original
selected-reference findings remain. Fixed versus tuned, provenance versus use,
entity inventories and exhaustive coverage still require independent assessment.
Quote units are not counted as semantic entities.

Program-assigned fN IDs identify those fallible findings for the one existing
optional revision. It returns `{answer, discharges, unresolvedFindingIds}`. A
discharge selects the same original aspect IDs, actual source IDs and new cN IDs.
Old claim links are cleared. Each listed source must already be selected by a
listed candidate claim, and each listed claim must select at least one listed
source. `selected-source-claim-edges-v1` records the actual per-claim edges without
adding references. A finding may address parallel answer claims; it is not a
single semantic assertion or entity. These edges never pool semantic support:
each claim still receives its own selected-only audit, and qualifications and
whole-question completeness still require independent source-first assessment.
Missing links, unresolved findings or `complete: false` retain the existing
`incomplete-scope-witness` branch without spending new local-audit calls. Linked
bindings are only `bindings-linked-awaiting-independent-review`; they are never
"accounted entities" or a coverage PASS. Eligible candidates still receive the
existing physically selected-only audits, without full-source rescue.

Original generation and low-profile local raw are restored under their own actual
wire identities. Historical v1 copied-witness scope responses are preserved but
are rejected by the new v2 shape; they are not relabeled or silently repaired.
Raw-before-parse, current-source rechecks, ordinary ledger, no retry, capacity
failures and the six-claim limit remain unchanged. Synthetic focused checks cover
ID restoration (including a legal wrong source), original PNG/caption members,
unknown/stale bindings, default compatibility, historical local reuse, capacity
and the one-revision selected-only boundary. They establish no semantic improvement
and change no old answers, source bytes, raw logs or benchmark scores.
### Qualification and inventory boundaries

The explicit scope-witness route distinguishes evidence that an item was used,
evidence that it satisfies the requested qualification, and evidence that a
qualified inventory is exhaustive. A broader list, baseline label, table row or
list position alone establishes neither qualification nor exhaustiveness.
Unresolved qualifications retain supported use/role facts with a bounded
explanation instead of an invented category boundary or a generic refusal.
These are fallible semantic instructions in the existing review/revision; they
add no model stage and do not turn ID validity or local support into acceptance.
