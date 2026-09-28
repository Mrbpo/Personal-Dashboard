# Canvas planner task identity and reconciliation

## Identity rule

A Canvas task uses `(course, object type, object ID, action index)`. A planner item can share an assignment, quiz, discussion, or page task only when `plannable_type` and `plannable_id` identify that object, or when an exact Canvas course URL identifies it and does not contradict the typed reference. Equal titles or equal numeric IDs across different types are insufficient. A missing or contradictory reference leaves the planner task separate for review.

The normalized planner source retains the outer `plannable_type` and `plannable_id`. The source hash includes those fields and the URL, so the first sync after this change records a new source version. `canvas_task_identity` maps a verified reference to an existing entity, including entities created under the earlier URL identity rule. Direct Canvas items take priority over planner summaries for task content and deadlines; corroborating evidence remains attached. User status is stored in its separate local status fact.

## Existing PostgreSQL duplicates

Migration `002_canvas_task_identity.sql` adds the identity mapping and a reversible merge record. It does not merge rows during deployment. After a fresh Canvas sync has recorded the outer planner reference, run the read-only report:

```text
npm run kernel:reconcile-canvas
```

The report shows the active task count, exact typed pairs, projected count, a plan hash, and unresolved planner records. Review its pairs and a database backup before applying. The operation rejects a changed count or plan:

```text
npm run kernel:reconcile-canvas -- --apply-verified --expected-active COUNT --expected-plan HASH
```

Each pair is merged in one transaction. The direct Canvas task remains visible and keeps its ID. The planner entity, its facts, fact versions, source versions, evidence, and adjudications remain in PostgreSQL with a `merged_into` link. Matching evidence is attached to the surviving fact; conflicting candidates remain pending for review. A planner's non-active local status transfers when the direct task is active. Conflicting non-active statuses block automatic merging. The old planner task ID redirects status and Canvas target calls to the surviving task. Projection rebuilds respect the merge.

If an old planner version lacks a typed reference, the report leaves it unresolved even if a direct object has the same number. After checking the Canvas object externally, record a manual decision with the exact task IDs and reason:

```text
npm run kernel:reconcile-canvas -- --apply-manual --planner PLANNER_TASK_ID --direct DIRECT_TASK_ID --reason "verified Canvas object reference" --expected-active COUNT
```

The operation still rejects a reference that contradicts the selected direct object. It never uses title equality as proof. An individual merge can be undone:

```text
npm run kernel:reconcile-canvas -- --rollback --planner PLANNER_TASK_ID
```

Rollback restores the planner task and visible count. It restores the direct task's prior local status if that status was still controlled by the merge; a later user status change is retained. Historical merge evidence and fact versions remain as an audit trail. Review the report again after rollback. No production reconciliation is performed by this PR.
