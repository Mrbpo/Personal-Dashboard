# Canvas planner task identity and reconciliation

## Identity rule

A Canvas task uses `(course, object type, object ID, action index)`. A planner item can share an assignment, quiz, discussion, or page task only when Canvas supplies both `plannable_type` and `plannable_id`. A URL alone does not prove identity because its host is not part of the normalized source contract. Equal titles or equal numeric IDs across different types are insufficient. A missing reference leaves the planner task separate for review.

The normalized planner source retains the outer `plannable_type` and `plannable_id`. The source hash includes those fields and the URL, so the first sync after this change records a new source version. `canvas_task_identity` maps a verified reference to an existing entity, including entities created under the earlier URL identity rule. Direct Canvas items take priority over planner summaries for task content and deadlines; corroborating evidence remains attached. User status is stored in its separate local status fact.

## Existing PostgreSQL duplicates

Migration `002_canvas_task_identity.sql` adds the identity mapping and a reversible merge record. It does not merge rows during deployment. After a fresh Canvas sync has recorded the outer planner reference, run the read-only report:

```text
npm run kernel:reconcile-canvas
```

The report shows the active task count, exact typed pairs, projected count, a plan hash, and unresolved planner records. Review its pairs and a database backup before applying. The operation rejects a changed count or plan:

```text
npm run kernel:reconcile-canvas -- --apply-verified --expected-active COUNT --expected-plan HASH --actor ADMIN_ID
```

Each pair is merged in one transaction. The direct Canvas task remains visible and keeps its ID. The planner entity, its facts, fact versions, source versions, evidence, and adjudications remain in PostgreSQL with a `merged_into` link. Matching evidence is attached to the surviving fact; conflicting candidates remain pending for review. A planner's non-active local status transfers when the direct task is active. Conflicting non-active statuses block automatic merging. The old planner task ID redirects status and Canvas target calls to the surviving task. Projection rebuilds respect the merge. The audit row records operator, time, reason, and before/after task counts and local statuses. `--actor` may be omitted when `SUDO_USER`, `USER`, or `USERNAME` identifies the operator.

If an old planner version lacks a typed reference, the report leaves it unresolved even if a direct object has the same number.

## Historical planner reference backfill

The regular Canvas scan keeps its moving 120-day past / 180-day future planner window. For older unresolved planner tasks, the server administrator can review a bounded historical plan after migration `009_canvas_planner_backfill.sql` is applied:

```text
npm run kernel:backfill-canvas-planner -- --as-of 2026-09-28
```

The plan is read-only. It selects unresolved planner tasks with verifiable stored Canvas source identity and a due date 121–365 days before `--as-of`, groups equal course/due-date candidates into 15-day inclusive windows centered on that date, and reports excluded tasks, the exact candidate count, windows, and `planHash`. At most 200 candidates, 120 windows, 20 API pages, and 2,000 planner items per window are allowed. Use `--from YYYY-MM-DD --through YYYY-MM-DD` to narrow the historical date range within those bounds. Save the reviewed JSON and check its course/date coverage and Canvas access before applying.

```text
npm run kernel:backfill-canvas-planner -- --apply --as-of 2026-09-28 --expected-count COUNT --expected-plan HASH --actor ADMIN_ID
npm run kernel:backfill-canvas-planner -- --status --expected-plan HASH
```

`--apply` requires the reviewed count and hash. The first invocation persists that exact plan; a later invocation with the same count and hash resumes its incomplete windows, even if successful earlier windows changed the live reconciliation report. An OS user can supply the actor when `--actor` is omitted. Run from a named administrator shell with `KERNEL_DATABASE_URL` and a read-only Canvas token configured in the service vault or environment. Only one backfill can run at a time. A window is fetched completely before any write. Each accepted planner source enters through the normal Canvas normalization and KernelService transaction, preserving prior source versions and facts. The stored course/source identity and Canvas's typed reference are verified first. Missing, ambiguous, or contradictory references stay in `review` and are retried on the next invocation. HTTP 403, partial pagination, and other errors leave the window in `error` with its last error and no advanced checkpoint. A crash between two source transactions likewise leaves that window resumable; repeated source hashes are idempotent.

The command never marks a Canvas course scan complete or declares absent historical planner items missing. After successful backfill, run the read-only reconciliation report again. Merging verified pairs remains a separate, reviewed `kernel:reconcile-canvas` operation with its own count and plan hash. This backfill does not perform a merge, deployment, or production execution.

### Integration order and migration identity

Merge in the coordinator-reviewed order **PR #52 → #54 → #57 → #48**. PDF migrations reserve `003` through `007`; course-video archival reserves `008`; this historical Canvas Planner backfill uses `009`. The former `003_canvas_planner_backfill.sql` in this unshipped PR has been renamed, with identical SQL bytes. The latest canonical-task-preservation fix and its tests remain in place. No source/fact algorithm, plan guard or actual backfill execution is changed by this integration correction.

The kernel migration ledger identifies migrations by the integer filename prefix. Two different `003` files would collide; a highest-version health check alone does not establish that every required table exists. Before deployment, check the combined migration directory's unique prefixes and the approved dependency order. This branch's standalone CI can apply `001`, `002`, `009` to a fresh isolated schema; that does not prove the PDF/video dependencies have been deployed.

This rename is valid because the Planner migration has not been applied in production. Do not rename existing ledger rows or alter an already-applied PDF migration `003`. If any persistent environment has already applied the old Planner `003`, stop and prepare a separate reviewed reconciliation; do not run `009` blindly against those existing tables.

Delivery status for this correction: **code complete**; byte identity and additive/version checks are locally verified, with the new head's **CI pending**. **Services are not deployed** and **production is not switched** by this PR. The historical planner CLI has not been run against production. The separate fresh PDF three-group retrieval gate has not passed in every group; this numbering change is not evidence of that gate passing.

If a historical item has no due date, lies outside the bounded range, or fails source identity checks, it is listed under `excluded` and needs separate review. A typed mismatch or missing direct object remains pending. Do not substitute equal titles, URL shapes, or numeric IDs for Canvas's exact typed reference.

After checking the Canvas object externally, record a manual decision with the exact task IDs and reason:

```text
npm run kernel:reconcile-canvas -- --apply-manual --planner PLANNER_TASK_ID --direct DIRECT_TASK_ID --reason "verified Canvas object reference" --expected-active COUNT --actor ADMIN_ID
```

The operation still rejects a reference that contradicts the selected direct object. It never uses title equality as proof. An individual merge can be undone:

```text
npm run kernel:reconcile-canvas -- --rollback --planner PLANNER_TASK_ID --reason "adjudication revised" --actor ADMIN_ID
```

Rollback restores the planner task and visible count. A persistent separation decision routes later planner syncs back to that entity while direct assignment syncs retain the direct entity. Evidence links and candidates copied solely for the merge are detached or superseded; any fact created solely by the merge is removed from the direct entity if it has not changed since. The original planner facts and their versions remain untouched. Rollback refuses to remove a merge-created fact that has since changed, so a reviewer can resolve that new history first. The direct task's prior local status is restored if it was still controlled by the merge; a later user status change is retained. Historical status transitions and the merge audit remain. Review the report again after rollback. No production reconciliation is performed by this PR.
