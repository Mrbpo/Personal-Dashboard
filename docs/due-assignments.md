# Deadline assignments instead of study plans

Issue: [#58](https://github.com/Mrbpo/Personal-Dashboard/issues/58).

The homepage reads canonical kernel tasks through the existing repository adapter. It shows incomplete overdue tasks plus deadlines from the user's local today through today + 15 days. The exclusive boundary is local calendar day today + 16, including across DST transitions. It is not a rolling 384-hour window. No twelve-item or study-capacity cutoff remains.

Date-only deadlines retain their original calendar date and display as all-day. Exact deadlines use their known instant and the user's configured IANA timezone. An elapsed exact deadline today is overdue; a date-only deadline today remains all-day. Invalid dates or exact timestamps without an offset are excluded rather than guessed. Completed, ignored, explicitly cancelled, unknown-deadline and out-of-window tasks are excluded. Locked, not-open and prerequisite-restricted tasks in scope remain visible with their current restrictions. Source disappearance alone does not cancel a task.

The homepage's deadline cards, completion actions, courses, search and surrounding layout remain. The duplicate deadline panel, daily-capacity estimates, suggested advancement and planning settings are removed. The course detail no longer shows suggested start times. Canvas Planner remains an ingestion source; its synchronization and completion mapping are unchanged.

Dashboard reads no longer query or generate daily plans. Manual sync, browser tools and local automatic sync no longer call the plan generator. Authorized requests to the old plan-generation and agenda endpoints return HTTP 410. Historical daily plans, agenda state and the retired capacity setting are retained; normal settings updates preserve the old capacity value.

## Verification and delivery

- **Code complete:** implementation is on the dedicated Issue #58 branch for PR review.
- **Tests:** six focused, zero-network checks passed: spring/fall DST boundaries, date-only precision, user timezone, completion/cancellation/restricted states, and dashboard reads with invalid historical plan JSON left untouched. TypeScript and lint for changed files passed. The existing PostgreSQL/container/build CI gate remains required.
- **Services deployed:** not deployed by this change.
- **Production switched:** not switched by this change. Homepage/API behavior must be checked after the coordinator's approved deployment.

Local Turbopack preview could not start with the reused Windows dependency junction because it points outside the detected project root. No UI screenshot or live API result is claimed from that attempt; dependency installation and production services were not changed.
