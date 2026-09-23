# Mail embedding backfill

This operator command rebuilds **existing stale vectors for active mail** with
the current subject-and-body input. It does not process messages without a
vector, removed messages, or orphan vectors. It prints only aggregate counts
and budget figures.

```sh
npm run backfill:mail-embeddings -- --limit 8 --batch-size 4 --max-cost-usd 0.005
npm run backfill:mail-embeddings -- --apply --limit 8 --batch-size 4 --max-cost-usd 0.005
```

The first command is a dry run. `--apply` makes paid embedding requests. One
run allows at most 500 messages, 32 messages per API call, and a $1 estimated
reservation cap; use much smaller values for the first production run. The
command also checks the remaining monthly AI budget. The existing
`paidOpenAI` reservation is the final atomic budget gate for each request.
Provider timeouts may retain their reservation because billing is uncertain.

`before` and `after` report active mail as `valid`, `stale`, and `missing`.
`orphan` counts vector rows whose message is absent or removed. These groups
must be assessed separately: this command reduces `stale` and raises `valid`,
but it does not repair `missing` or delete `orphan`. A failed or interrupted
run leaves unfinished stale rows in place; rerun the same command to continue.
If a mail changes during an API request, its previous row remains untouched
and the new hash is handled on a later run. Completed rows are replaced in a
single database write, rather than deleted before the new vector exists.

Before applying on production, confirm the running code version, a recently
verified encrypted backup, API configuration, and AI budget headroom. Run a
small dry run and apply batch, then compare valid/stale/missing/orphan counts
and the AI ledger. Repeat with bounded batches while web and worker remain
healthy. Stop on an unexpected error, budget exhaustion, or inconsistent
counts; a later invocation resumes safely.

Rollback is to stop further batches. Unprocessed legacy rows remain available
in the database. A completed row's old vector is replaced, so reverting that
row requires a **selective** restore from the pre-run encrypted backup or
regeneration; never restore the whole production database over newer user
data. Check the current mail hash before any selective restore. The code
change can be rolled back independently, but older code may rebuild affected
mail embeddings using its previous input format.
