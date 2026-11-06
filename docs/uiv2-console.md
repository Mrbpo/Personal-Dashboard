# UI v2 console — Issue #295

Independent Monitor/Operate interface at `/uiv2`, with no classic page or global theme changes.

## Route map

- `/uiv2`, `/uiv2/tasks`, `/uiv2/courses`: new dashboard views using `/api/dashboard`, existing deadline/presentation helpers, and the existing task PATCH API with `syncCanvas: true`.
- `/uiv2/study`: `StudyWorkbench`, preserving kernel/facts-only configuration.
- `/uiv2/library`: `LibraryCenter` (search, upload, directory, processing).
- `/uiv2/recordings`: `RecordingSyncControl` and `RecordingPlayer`.
- `/uiv2/mail`: `MailCenter`.
- `/uiv2/health`: `HealthDashboard`.
- `/uiv2/ai-usage`: `AiUsagePanel`.
- `/uiv2/settings`: existing preference, course, access, service, Gmail and feedback forms.
- `/uiv2/system`: background tasks, release controls, Hermes, terminal, kernel and change links.

Course details and document readers explicitly open classic `/courses/:id` and `/library/:id`. Supported v2 detail URLs show a handoff rather than pretending to implement a reader. Piazza configuration stays in classic settings. Hermes and terminal use the existing shell's reverse-proxy paths `/hermes/` and `/terminal/`, not new application endpoints.

The pure route allowlist rejects unknown keys and unsupported tails. Layout and page independently call `requireOwnerPage`; no private data loader is reached from an unauthorized page. Existing API authorization is unchanged.

## Local verification

Executed sequentially with 2 GB Node heap cap for heavy commands:

- `npx eslint app/uiv2 components/uiv2 lib/uiv2 tests/uiv2-console.test.ts`: passed.
- `node --experimental-strip-types --test tests/uiv2-console.test.ts tests/due-window.test.ts`: 13 passed, 0 failed (7 new route/security/source-contract tests plus 6 deadline tests).
- `npx tsc --noEmit`: passed.
- `npm run build -- --webpack`: passed on Next 16.3.4; parent repeated the full production build successfully after correcting legacy CSS-module selectors to `:global(...)` and terminal naming.
- `npm run lint`: fails in untouched existing tests (217 errors, 100 warnings; primarily `no-explicit-any`). Scoped new-code lint is clean. No unrelated fixes made.
- `git diff --check`: passed.
- Production server bound only to `127.0.0.1:3295`: all requested top-level v2 surfaces returned a login prompt without private content; `/api/dashboard` returned 401 without authentication. Unknown paths also show the layout login gate while unauthorized; pure resolver rejection is unit tested.
- Browser inspected production login/shell at 1280 px and 390 px: no horizontal overflow; mobile navigation button changes `aria-expanded` from false to true and reveals navigation. Active route and skip-to-content semantics present.

## Remaining review

No credentials or production/private data were used. Authenticated views, task mutations, file uploads, playback, external service connections, release actions and live backend success/error flows need owner-session acceptance testing in the normal review environment. Unit source-contract checks are not a substitute for those integration tests. No fabricated data or backend responses were used. The original AI-usage component's existing loading/error semantics remain unchanged.

No commit, push, merge or deployment was performed.
