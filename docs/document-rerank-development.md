# Administrator development reranker runs

Refs #68. Ordinary application reranking still uses `pdf-search-rerank`,200 requests/day and the existing monthly runtime budget. Existing administrator policies up to350/day remain compatible. No counters, ledger rows or charges are reset.

An isolated administrator script may explicitly use:

```ts
await withDocumentRerankRunPolicy({
  scope: 'development',
  dailyLimit: 1000,
  maxAttempts: 1,
  model: 'gpt-6-astra',
  reasoningEffort: 'high',
  maxOutputTokens: 16384,
  deadlineMs: 120000,
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

The development runner may set its own `AI_MONTHLY_BUDGET=200` following the user's development-testing authorization and verify the effective budget. This helper does not change monthly settings, production configuration, embedding limits or the normal runtime allowance. It does not activate `AI_BUDGET_TEST_BYPASS`. Every real provider attempt retains the existing ledger kind, usage and actual charges, including ambiguous reservations. Cached successful work stays reusable.

## Explicit model configuration

Only `development` accepts model options. The allowed models are `gpt-5-mini` and `gpt-6-astra`; defaults remain mini, `low`,4000 output tokens and30000ms. Astra accepts `low/medium/high/xhigh/max`; mini accepts `low/medium/high`. Output limits are integers1–32768, including reasoning tokens; deadlines are integers1000–180000ms shared by all permitted attempts. Incomplete responses fail and are never cached. These settings cannot be supplied by a public search/API request.

The model, effort and output limit bind request parameters, cache identity and hit diagnostics (`rerank_model`, `rerank_reasoning_effort`, `rerank_max_output_tokens`). The fixed historical mini/low/4000 cache namespace stays compatible; all other combinations use explicit effort/output fields. Deadline does not change successful content identity, but active flights also bind scope/limits/deadline so concurrent ordinary work cannot inherit development policy. Cache reads retain owner, current source/version/evidence and metadata checks. The administrator journal receives `JSON.stringify([owner,cacheKey])` before uncached work, with this model configuration included in `cacheKey`.

`assertDocumentDevelopmentRun()` is the exported environment guard for other internal operations; it checks only the trusted flag and exact stores. A caller using it must still require its own durable attempt journal. It does not establish that an already-created database pool targets those stores.

Astra standard prices are input$10/M, cached input$1/M, cache writes$12.50/M and output$50/M. For actual input exceeding272000 tokens, input/cache rates double and output increases1.5× for the full request. Reservations conservatively bound UTF-8 request bytes plus overhead, using the highest cache-write rate and corresponding tier. Settlement uses provider input/output usage, including reasoning output and distinct cache read/write tokens; malformed usage or a mismatched Astra model retains the reservation. Existing mini/embedding accounting is unchanged. Custom `AI_MODEL_RATES` remains an administrator responsibility. Sources: [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra), [prompt caching and usage](https://developers.openai.com/api/docs/guides/prompt-caching).

No real Astra inference was performed by this implementation change. Model-list visibility and mocked contract tests do not prove inference success; an Astra-only test result cannot certify the mini production model.

The higher development allowance does not certify retrieval, answer correctness or transcription fidelity. Exact frozen inputs, source/evidence checks, observed costs and formal acceptance status still belong in the run report.
