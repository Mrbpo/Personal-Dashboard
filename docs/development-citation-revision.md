# Development citation revision

Issue #131 adds the explicit application-internal
`KernelService.reviseSelectedStudySourceCitation` method. No route, UI, normal
answer call or production switch invokes it. It uses the existing isolated
administrator development policy and complete current-source Kernel reader.

The input binds an existing selection object to its current context and quote
manifest, and records the SHA256 of its historical provider request and raw
response, its historical input fingerprint and answer version. These are
caller-bound historical receipts; Kernel does not claim to verify old raw files.
Historical files and scores remain separate. Rebinding an older context requires
the old/current fingerprints and a hashed proof reference in the durable journal
and accepted revision. The controlled runner must verify that proof and the
original files; rebinding is not an exact wire replay.

The flow selects at most the first quantitative/comparative claim whose actual
selected citations are all text. This is a risk trigger, not a support judgment.
Candidate PNGs must share the current document/version/source/evidence anchor
of an actual selected text unit. Missing, ambiguous or more than two linked
images leave the original unprocessed. Image-grounded controls are unreviewed
and make zero calls when no other risk claim is selected.

At most three sequential mini54 low/1000-output/30-second calls are possible:

1. Existing isolated audit of only the original claim's actual references.
2. If unsupported, one citation-only proposal using its selected quotations and
   at most two linked original PNGs. `no-supported-reference` with empty IDs is
   always valid. A caption link does not establish image support.
3. One isolated audit of only the proposed references. Acceptance also requires
   an actual selected image finding to support the claim and no contradictory
   finding or unresolved object/unit/scope alignment.

Only citation IDs can change. Claim text/order, answer status and message are
preserved. A failed or unresolved attempt returns the original and no revision.
Every other claim is explicitly unreviewed; `wholeAnswerVerified` is always
false. Model judgments remain fallible and do not establish full-source coverage.

The caller must append durable original/result states, journal each attempt
before reservation/HTTP, and persist raw responses before parsing or validation.
The existing SQLite AI ledger remains active: this entry requires
`AI_BUDGET_TEST_BYPASS=false` and the effective mini54 input/output/context
configuration to match its frozen $0.75/$4.50 per million and 400,000 assumptions,
at entry and again before each paid phase. Each attempt exposes its actual
text/image input upper bound and the greater of that cost and the existing
provider reservation estimate, so an experiment can enforce its shared cap.
Timeouts and unknown responses stop the flow; no retries or model upgrades occur.
This module does not authorize running a paid calibration experiment.
