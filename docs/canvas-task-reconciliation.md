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

If an old planner version lacks a typed reference, the report leaves it unresolved even if a direct object has the same number. After checking the Canvas object externally, record a manual decision with the exact task IDs and reason:

```text
npm run kernel:reconcile-canvas -- --apply-manual --planner PLANNER_TASK_ID --direct DIRECT_TASK_ID --reason "verified Canvas object reference" --expected-active COUNT --actor ADMIN_ID
```

The operation still rejects a reference that contradicts the selected direct object. It never uses title equality as proof. An individual merge can be undone:

```text
npm run kernel:reconcile-canvas -- --rollback --planner PLANNER_TASK_ID --reason "adjudication revised" --actor ADMIN_ID
```

Rollback restores the planner task and visible count. A persistent separation decision routes later planner syncs back to that entity while direct assignment syncs retain the direct entity. Evidence links and candidates copied solely for the merge are detached or superseded; any fact created solely by the merge is removed from the direct entity if it has not changed since. The original planner facts and their versions remain untouched. Rollback refuses to remove a merge-created fact that has since changed, so a reviewer can resolve that new history first. The direct task's prior local status is restored if it was still controlled by the merge; a later user status change is retained. Historical status transitions and the merge audit remain. Review the report again after rollback. No production reconciliation is performed by this PR.
