# Bounded original-page repair

This administrator tool stages selected-page visual transcription without running a whole-document reparse or changing the UI. The default visual helper still has its existing behavior; selected pages use a separate source/model/render/prompt-specific cache (`pdf-visual-selected-v2`). The selected subset must have distinct valid original 1-based page numbers, up to the existing 24-page limit. The repair CLI is deliberately limited to two pages total and a maximum $0.236 conservative reservation per invocation. Existing monthly and 60-per-UTC-day limits remain enforced; there is no automatic retry or budget bypass.

A JSON plan contains `{owner,documents:[{documentId,sourceHash,expectedVersion,pageNumbers}]}`. The original blob checksum, owner, current PostgreSQL version and complete original page inventory are checked before recognition. Copying/rendering preserves original page identity. Only the original page image is sent to recognition; no query, gold answer or hand-authored formula is supplied. The fidelity prompt forbids correcting source spelling or mathematics and asks for standard delimited LaTeX in original reading order. A model's `complete:true` is not proof of faithful mathematics.

```text
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json --recognize
```

The first command estimates effective rates, existing ledger balance, cached work and remaining daily quota without a model call. Recognition first checks that the result file is writable, saves each successful page and leaves the searchable head unchanged. Review the result against the original render for symbols, limits, signs, source typos, equation regions, reading order and LaTeX syntax. If it is unfaithful, retain the failure and stop; do not hand-edit the result to match a test answer.

Only after a faithful review:

```text
node --experimental-strip-types scripts/repair-pdf-pages.ts --plan PLAN.json --result RESULT.json --apply
```

Apply makes no model call. It accepts only the exact validated cache text and atomically publishes a complete new document version through KernelService, reusing the other current pages. A transaction-level current-version guard rejects concurrent changes. New page evidence stores the repaired page's model/parser or the unchanged page's previous method/model, with links to prior version/source/evidence. Old versions and evidence remain. A partial multi-document apply is recorded after each complete document; a resume verifies the recorded whole current version and text hashes before skipping that document. It cannot skip based solely on a status marker.

## Actual isolated check (2026-10-14)

The source targets were only MIT 6.867 lecture 8 original page 2 and problem-set-4 solutions original page 1. The existing complete documents contain 5 and 8 pages respectively; other pages were neither recognized nor republished.

- Local visual/helper mocks passed; actual temporary PostgreSQL schema checks passed **2/2, zero skips**, covering old-page/evidence retention, atomic publication, current-version rejection, exact completed-work verification and preservation of a prior repaired page's model/parser. TypeScript and targeted lint passed.
- First recognition attempt encountered an isolated output-directory permission error after one successful cached page. The directory ownership was corrected and the cached page reused; no duplicate recognition charge occurred. The CLI now checks staging writeability before spending budget.
- Fidelity v1 used two actual requests, settled at **$0.006608**, and failed manual fidelity/LaTeX review. It changed an original repeated Gamma(a) denominator to Gamma(b), and produced invalid/bare math commands.
- The coordinator authorized exactly two additional generic fidelity-v2 requests, with a distinct cache/result file. They settled at **$0.007701** and also failed: source math was still corrected and lecture display/inline formatting remained inconsistent. Initial outputs were retained, not overwritten.
- Total: **four requests / $0.014309**. Isolated ledger used $3.71975054 of its unchanged $5 cap, leaving $1.28024946; daily visual allowance remaining 56. No further requests were made.

**Code:** bounded helper/CLI and provenance guard implemented. **Tests:** focused code checks passed; the two real recognition attempts did not pass source-fidelity acceptance. **Services deployed:** PDF application changes not deployed. **Production switched:** not switched by this work. No known-unfaithful result was applied, so the public acceptance owner's existing parsed heads remain unchanged. Neither the fresh retrieval gate nor global formula fidelity is certified by this check.
