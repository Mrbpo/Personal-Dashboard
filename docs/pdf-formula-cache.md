# Formula cache and explicit recovery

Formula enrichment uses the existing `library_parse_pages` store with a versioned
`pdf-ai-formula-v2` identity. It binds original PDF SHA256, physical page, complete
base-text SHA256, effective configured model and the fixed prompt/schema/output/
structure policy. The JSON cache keeps those identities, original base text and
validated formula strings, marked `machine-unverified`. Old v1 entries remain
available as history and are never treated as new-policy hits.

Only provider-complete, structurally valid formula results enter this cache.
Control characters, mismatched math/environment boundaries and unbalanced braces
cannot become a complete formula result; valid partial strings remain visible
with an incomplete warning. This is a bounded syntax check, not a TeX compiler or
proof of correct symbols, numerical values, source coverage or PDF fidelity.

Normal reads of an existing page make no new request, including a partial page.
The existing owner-scoped manual reparse job is the only recovery trigger. Its
force flag now reaches the compatibility page parser, and v3-only incomplete
pages can use the existing status/queue flow. Recovery attempts each eligible
page once, within the existing24-page/document and normal daily/budget limits;
there is no internal retry, background backfill or new worker mechanism.

A recovery supplements the entire prior body rather than guessing where native
prose ends. Original prose, valid partial formulae and old warnings survive
verbatim in the new policy cache and the next ordinary Kernel source version.
A matching complete proof resolves only the latest formula-enrichment step;
historical warnings stay visible and machine-generated formulae remain
unverified. The existing page update uses compare-and-swap. Invalid cache rows
are preserved and refused without an automatic model request.

The default model, prompt, output budget, services and UI are unchanged. The
existing Docling converter and Kernel service are unchanged. Two mocked focused
tests cover cache identity/zero-request reuse and explicit partial recovery;
these tests do not constitute scientific transcription acceptance or deployment.
