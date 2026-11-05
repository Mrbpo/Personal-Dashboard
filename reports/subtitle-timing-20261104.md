# Lecture subtitle timing: bounded investigation and candidate repair

Issue: #290. Base: `c34b6d6` (v1.5.1). No production change or bulk regeneration.

## Observed failure

Read-only inspection found 147 published bundles containing 110,654 cues:
10,466 exceed 8 seconds, 3,744 exceed 15 seconds, 806 exceed 30 seconds, and
119 exceed 60 seconds. The longest observed interval was 297.64 seconds for a
short sentence. These are duration statistics, not a count of proven wrong cues.

The active transcriber exports whole faster-whisper segments with VAD enabled,
without word timestamps. Restoring these segment boundaries to the original
audio can span intervening silence. Chinese translation inherits the same cue
windows. The player uses the native video clock; no separate Chinese timing
offset was found in this path. Translation indices alone cannot detect acoustic
misalignment. Cross-cue semantic translation errors remain a separate possibility.

## Candidate

An opt-in `word-pause-v1` profile requests native word timing from the existing
small.en int8 model, then groups observed words using real pauses, punctuation,
7-second and 14-word limits. It preserves the ordered lexical content of the
word-timed result; it does not guarantee that result matches the old ASR text or
the original speech. Invalid timing requires review instead of fabricated timing.
Profile-specific caches and hashed word evidence retain source/version identity.
Legacy remains the default. Existing assets and completed queue rows are untouched.

## Real-audio A/B

Identical input, model, beam size, VAD and thread count; only word timing differs.
One slow mathematics clip (120 seconds) and one biology control (60 seconds).
Private audio and raw text remain server-side, outside this public repository.

| Measure | Math legacy | Math candidate | Biology legacy | Biology candidate |
| --- | ---: | ---: | ---: | ---: |
| Cue count | 14 | 17 | 11 | 17 |
| Longest cue (seconds) | 27.17 | 4.10 | 7.76 | 5.50 |
| Cues exceeding 7 seconds | 6 | 0 | 3 | 0 |
| Caption duration outside VAD speech (seconds) | 75.858 | 0.496 | 0.002 | 0.002 |
| Inference wall time (seconds) | 31.020 | 43.229 | 30.981 | 30.106 |

VAD overlap is an automated speech/pause proxy, **not** a manually labelled timing
error score. Segment grouping preserved every non-whitespace character of each
word-mode result. Biology word tokens matched legacy. Mathematics had some
insertions/substitutions, including a mathematical phrase: semantic/term accuracy
is not certified, and the existing model's recognition errors are not fixed here.

Resource ceiling: 2 CPU cores, 1,600 MiB, 600 seconds. Four bounded local ASR runs
completed in approximately 135.34 seconds of inference wall time; maximum RSS
903,812 KiB. Paid API calls: **0**. No full-video download, model download, service
restart or original recording modification.

## Checks and limits

- Python: 21 focused checks passed, plus the final newly added failure-state
  check passed separately (22 distinct checks). Initial isolated copies lacked
  repository-relative files, causing two harness errors; corrected the directory
  layout without changing test expectations. A later mistyped test selector was
  corrected; it was not a product failure.
- TypeScript: 6 focused checks passed; `tsc --noEmit` passed.
- Replayed the saved math word observations through the actual transcription
  CLI: 17 VTT cues, correct source window, valid VTT and word-evidence hashes,
  zero additional inference. The real packaging CLI accepted them with zero
  calls and preserved absolute source offsets and timing provenance. Its first
  isolated run lacked `zod`; reused existing dependencies without installation.
- No new Chinese generation, human acoustic alignment audit, browser playback
  review or complete lecture processing was performed. Existing bilingual VTT
  rendering checks passed; these do not establish Chinese content accuracy.

Private evidence: `/srv/agent-ops/evidence/subtitle-timing-20261104/` contains
sample provenance, raw A/B, `ab-summary.json`, candidate words/cues, CLI replay
and the isolated packaged bundle. Shared operations task:
`subtitle-timing-20261104`. Private records must not be committed to GitHub.

Delivery: candidate code complete; focused checks and bounded audio timing
comparison passed within the limits above; service **not deployed**; production
**not switched**. Release review and a selected-lecture regeneration/playback
check are still required. No claim that old subtitles are already corrected.
