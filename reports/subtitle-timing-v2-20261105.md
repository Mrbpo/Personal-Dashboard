# Subtitle timing v2 follow-up (#290 / PR #291)

Three reported defects addressed in code: readable display holds, phrase-aware
length limits, and cross-cue Chinese content migration. The new profile is
`word-pause-v2`, opt-in; legacy production defaults and old evidence are retained.

Display starts at observed speech and holds for at least one second where the
next cue and clip boundary permit. `speechStart/speechEnd` remain separate from
display times in hashed evidence. The phrase segmenter looks back for better
boundaries and protects quantities/function words rather than cutting at the
14th word. Its rules are heuristic, not a linguistic parser: a true long pause
can still separate an incomplete phrase, and inaccurate ASR word positions are
not corrected by text grouping.

V2 translations use separate requests for each cue, with course title metadata
but no preceding/future cue text. They keep fragments incomplete. This removes
the observed route for moving future cue content backwards, but cannot guarantee
against all model inference or incorrect terminology. Prompt version v2 is
stored and validated; old translated bundles cannot impersonate this profile.
Legacy 60-cue batching remains unchanged. Single-cue requests increase request
count and latency; existing daily/monthly/invocation caps and durable continuation
remain enforced, with 1024 output tokens per request instead of8000.

## Verification

Replayed five saved word observations; no new ASR:

| Sample | Shortest display | Longest display | Word-mode text retained |
|---|---:|---:|---|
| Math120s |1.00s|4.10s|yes|
| Biology control60s |1.00s|5.50s|yes|
| Biology75s |1.00s|5.42s|yes|
| Physics75s |1.92s|6.68s|yes|
| Chemistry75s |1.00s|6.08s|yes|

The actual40ms biology observation remains40ms in speech evidence and displays
for1s. The physics quantity phrase stays together. A remaining determiner near
a long pause is not acoustically re-aligned; this is a limitation, not a passed
natural-language readability claim.

Two bounded three-request mini experiments cost a confirmed totalUS$0.002295
(combined reservation belowUS$0.05), with no retries. Both kept carbon/hydrogen
content out of the preceding chemistry cue. Final requests used the actual
request builder with course labels. Some wording remains imperfect (general
formula terminology and force count/category phrasing); these experiments pass
the specific leakage check, not full translation semantic acceptance.

22 focused Python tests passed. Initial regression incorrectly classified
identifiers ending in digits as quantities; fixed full-token number recognition
without changing the existing test expectation.10 focused TypeScript tests,
type checking and affected lint passed. All prior responses/evidence retained.

Evidence is private at `/srv/agent-ops/evidence/subtitle-timing-20261105/`;
source audio/raw transcripts are not committed. Production not deployed/switched;
no completed lecture requeued. Full-lecture bilingual playback and semantic
acceptance remain pending. Prior v1 reports remain historical snapshots.
