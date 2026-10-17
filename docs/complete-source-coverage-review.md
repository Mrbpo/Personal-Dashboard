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

### Explicit question-scope witnesses (Issue181)

`scopeWitnessPolicy: 'question-scope-v1'` opts the existing complete-source review and
one-content-revision exchange into a new semantic protocol. It requires explicit
`completeSourceReview` and rejects legacy `citationRevision`. It is independent of the
execution-only `auditProfile`; absent the new policy, old request bytes and identities
remain unchanged. No phase, model, output allowance, contract-v1 field or database table
is added. Coverage and proposal schemas/identities use
`complete-study-scope-witness-v1` and `complete-study-scope-revision-v1` respectively.

For each fixed rN, coverage returns a compact `scopeWitness`: answer kind (positive
existence, enumeration, other or unclear), exact question span, relevant qualification
spans and only the relevant mN members. Each member records eligible/excluded/unclear,
actual source witnesses and original cN claim bindings. A witness binds a question span
to a supplied source ID, an exact original text quote (or null for actual input pixels)
and a fallible supports/contradicts/unclear judgment. There is no mandatory tool/role
table. For example, experimental use and component provenance are separate predicates;
unknown provenance cannot become exclusion merely because a system is a baseline.
Exclusion requires a contradictory witness, never silence. IDs, spans, text identity
and pixel identity are validated; these checks do **not** validate semantic entailment
or prove that the model discovered every relevant member.

The one existing proposal returns `{answer, discharges, unresolvedMemberIds}`. Each
discharge binds an existing mN to new cN claims and reuses or replaces its source witnesses.
All typed witness source aliases, including pixel aliases, are restored and validated;
old claim bindings are cleared. No citation is added implicitly. At least one mapped
claim must actually select the member-identity witness and witnesses for every required
qualification. Citations from different claims cannot be pooled to pass that check.
Enumeration requires every relevant member to be accounted for; unclear members remain
incomplete. Positive existence needs one qualifying selected witness and does not demand
an unrelated inventory. Negative existence and all-excluded inventories are conservatively
incomplete in this version. This mechanism is not a universal semantic verifier.

Missing/unclear bindings, explicit unresolved members or `complete: false` retain a
separate `incomplete-scope-witness` candidate with `questionCoverage: 'incomplete'`.
It cannot be upgraded by a generic selected-only `supported` result; new local audits
are skipped for that incomplete branch. Accounted candidates still receive only the
existing physically selected-reference checks and await independent review. Capacity
must be reported explicitly; malformed/over-limit results retain raw and fail without
truncation, retries or inventing additional members. The original answer/raw, source,
question, contract and historical accuracy scores remain separate and unchanged.

Necessary synthetic protocol regressions cover default wire compatibility, distinct
identity, enumeration versus positive existence, unresolved/excluded handling, exact
question/text/image bindings, alias restoration, cross-claim citation isolation, reuse
of historical local raw and the incomplete branch. They do not establish semantic
improvement. A later authorized real pilot must independently check the complete
question's qualifications against original source and actual selected references;
role confusion, an omitted eligible member or unsupported exclusion falsifies success
even if the ledger says accounted or every local check says supported.
