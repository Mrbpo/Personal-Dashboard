# Optional literal source scope

`STUDY_SCOPE_ANNOTATIONS=literal-source-v1` enables an experimental generation contract on the existing kernel study API. Default is `off`; legacy and ordinary kernel behavior remain available. It requires ordinary `select-then-answer` plus `selected-once` citation checking and rejects specialized source-value/quantity contracts.

Each generated claim declares a necessary source restriction, no restriction, or unknown necessary scope. A restriction must be an exact unique literal in an actually cited selectable text unit. The server records its original unit hash and UTF-16 page offsets, and displays that literal with the claim **before** the existing citation check. The same derived text is audited and returned. Original provider selections and derived audit selections remain separate. Unknown necessary scope produces a neutral insufficient-evidence result; malformed binding is rejected. No new reviewer, automatic revision loop, index, source mutation or UI is added.

Exact binding proves that the literal occurs in the source. It does **not** prove it is a meaningful or complete restriction. All receipts set `semanticScopeVerified=false`; ordinary content/citation acceptance must still establish correctness. A generated label such as “annotating” may bind successfully while being too vague. This feature must not be enabled in production on the strength of schema checks or a single exposed sample.

The initial component experiment reused the actual website generation payload and retained a previously omitted dev/test qualification. Its second scope label was weak. That mixed result justifies isolated API calibration only, not a claim of semantic correctness or final acceptance. Original failed tests and Gold remain unchanged.
