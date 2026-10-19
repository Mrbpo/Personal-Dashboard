# Original PDF internal navigation observations (Issue #203)

`PDF_INTERNAL_LINK_OBSERVATIONS=goto-v1` opts the existing PDF visual-evidence
preparation into observing native `/GoTo` and direct `/Dest` link annotations.
Unset or `off` retains the prior content projection/hash. No new service,
database table, model call, OCR, page image or background backfill is added.

The existing original PDF load provides the observations. Source annotation
index/ref, original default-user-space `/Rect`, literal destination name,
actual page-object destination, view and nullable parameters are retained.
Coordinates are not silently normalized for crop/rotation or asserted visible.
Page integers, missing names, duplicate destinations, incomplete/cyclic name
trees, unknown destination syntax and conflicting action/direct destinations
are never guessed. Unsupported/external actions are counted and never executed.

Bounds are 500 original pages, 10000 examined annotations, 2000 recorded links,
10000 names/name-tree nodes, tree depth 32, destination-name length 512.
`available` describes scan availability, not semantic validity; individual
targets can remain `unknown`. Partial scans explicitly retain that status.
These are navigation observations, **not verified citation equivalence,
text-label associations, task roles, or canonical facts**.

Observations live in the existing immutable PostgreSQL PDF content manifest.
Its original SHA, content hash and current source-version binding cover them;
the current publication pipeline naturally creates a distinct derivative when
the opt-in content changes. History is not rewritten. Rebuild from the original
PDF, not a vector or graph copy.

For an administrator's explicitly scoped cached-native audit/replay, the same
opt-in detects a missing navigation index as a visual-metadata derivative even
when text/layout already match. Existing CAS/review guards apply. Once recorded,
the replay is unchanged; original text, warnings and parser identity are retained.
Nothing scans or republishes old sources automatically.

`KernelService.readPdfInternalLinks(owner, source)` reads the bounded metadata
without loading any image or consuming an image-input budget. It performs the
same owner/current-version/original-source checks and verifies manifest/content
hashes. Historical manifests without observations return `not-recorded`.
Enabling ingestion does not attach these observations to model generation yet.

## Evidence and limits

The saved public KALM original has 42 internal GoTo links. Independent local
pdf-lib and pypdf reads agree on all 42 source rectangles/names/targets/views.
Three links from physical pages 4,4,5 explicitly share one named target on page
7. This establishes original navigation only. It does not prove the C40 answer
correct, fix C49 comparator substitution or pass independent RAG acceptance.

Targeted tests cover native mappings, unknown/duplicate/cyclic cases, bounded
coverage, unchanged source objects, disabled projection parity, existing
manifest persistence, metadata-only reads and rejected owner/stale/policy
bindings. Real whole-answer API acceptance remains separate.

## Text-container candidates (Issue #204)

`KernelService.readPdfNavigationTextContainers(owner, source, physicalPage)`
combines current native navigation with the existing bound Docling region read
and the exact current stored page. It returns candidates only for a compatible
zero-origin/unrotated frame, a unique text box fully containing the native link
rectangle and a unique exact occurrence of that parser text in the page body.
The original source/version, page evidence/body hash, raw parser-result reference,
annotation and observed box/range remain traceable. No nearest-box selection,
text normalization, inferred word-level link or semantic equivalence is added.
Ambiguous/incompatible/unavailable cases keep explicit unknown/unavailable states.

The deterministic `coverPdfNavigationContainer` utility can establish that a
set of already selected UTF-16 ranges collectively covers a parser container.
It does not fill gaps, including whitespace gaps, or import additional text.
That is a group relation: it does not assign the native link to an individual
word or one arbitrarily chosen quote unit. Caller quote IDs are not accepted as
current model references by this reader. This slice is not connected to the
generator yet; answer accuracy and final website API acceptance are still open.
