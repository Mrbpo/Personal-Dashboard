# Administrator development reranker runs

Refs #68. Ordinary application reranking still uses `pdf-search-rerank`,200 requests/day and the existing monthly runtime budget. Existing administrator policies up to350/day remain compatible. No counters, ledger rows or charges are reset.

An isolated administrator script may explicitly use:

```ts
await withDocumentRerankRunPolicy({
  scope: 'development',
  dailyLimit: 1000,
  maxAttempts: 1,
  beforeAttempt: async cacheIdentity => {
    // Persist and fsync the attempt identity before requesting the provider.
    await durableAttemptJournal(cacheIdentity);
  },
}, runFrozenAcceptance);
```

The trusted process environment must have all three:

- `KERNEL_ADMIN_DEVELOPMENT_RUN=true`
- A PostgreSQL `KERNEL_DATABASE_URL` whose exact pathname is `/pdf_acceptance_20261006`.
- `DATABASE_URL=file:/pdf-data/benchmark.sqlite`, exactly.

Only this `development` scope permits daily limits above350, capped at1000. The attempt journal callback is required; `maxAttempts` stays1 or2. The helper awaits this callback before a paid attempt, but the administrator runner remains responsible for journal durability and refusal of a repeated identity. `AsyncLocalStorage` confines the policy to its work and restores the ordinary default for siblings/afterwards.

These flags come from the administrator process, not query/API parameters, document content, website service settings or prompts. Run a separate isolated process; verify its actual PostgreSQL database and frozen owner/source/evidence scope before supplying candidates. Do not repoint a running application or reuse a pool already connected elsewhere.

The development runner may set its own `AI_MONTHLY_BUDGET=100` following the user's development-testing authorization and verify the effective budget. This helper does not change monthly settings, production configuration, embedding limits or the normal runtime allowance. It does not activate `AI_BUDGET_TEST_BYPASS`. Every real provider attempt retains the existing ledger kind, usage and actual charges, including ambiguous reservations. Cached successful work stays reusable.

The higher development allowance does not certify retrieval, answer correctness or transcription fidelity. Exact frozen inputs, source/evidence checks, observed costs and formal acceptance status still belong in the run report.
