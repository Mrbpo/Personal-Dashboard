# Native table projection validation

The Docling decoder validates all cell starts before allocating Markdown rows or resolving rich cell text. Starts must be safe nonnegative integers inside the declared grid. Optional dimensions remain optional (and unknown); when supplied they must be positive safe integers. Both declared and undeclared grids use the same existing bounds as native table artifacts: 1,000 rows, 200 columns, 10,000 cells.

Duplicate starts fail regardless of whether either cell has empty text. This prevents a later empty record from silently deleting searchable content. The decoder does not expand a contradictory declared grid, choose a winning cell, guess spans, assign headers or certify native structure. Existing valid text formatting and raw cell records are unchanged.

Failure is explicit and propagates through the existing parse failure path; this change does not publish a partial repaired table. Original PDF/result blobs and existing document versions remain retained. It does not reparse the corpus or rewrite old cached projections. Parser format identifiers stay unchanged because valid outputs are byte-identical; this is input validation, not a new source representation. Previously accepted malformed caches are not retroactively certified by this guard.

Tests distinguish synthetic malformed-input rejection, valid-input preservation and a bounded child-process resource regression from content accuracy. A saved public raw result can provide a byte-for-byte decoder control, but neither that nor CI proves table labels, spans or question answers agree with the original PDF. In particular, upstream merged/misbound labels and uncertain structure remain unresolved.
