# Per-video subtitle generation and embedded-camera controls

Issue #263. Application changes are isolated on `codex/recording-subtitle-request`, based on `31c46ac`. They have not been deployed. This report covers the controls, not whole-lecture transcription accuracy.

## Functionality

- Selected-view subtitle generation/completion button exists only while complete bilingual captions are missing. Automatic backlog entries can be explicitly prioritized. Manually queued/running jobs disable duplicate clicks, deferred jobs retain their budget/resource time, and failed jobs require review. Completed bilingual captions hide the button.
- Metadata includes safe generation state. POST uses normal owner/same-origin checks, accepts no caller-controlled task parameters, resolves the current view to an original SHA, and publishes a complete/exclusive request. The root bridge independently verifies a current archived original and modifies the queue only under its existing lock.
- The separate fixed subtitle request path/unit avoids occupying or waiting for the long discovery/authentication controller. No network microservice or Docker socket was added. Existing running leases, checkpoints, attempts and `notBefore` remain preserved.
- The browser polls every five seconds for at most fifteen minutes while explicitly queued/running; refresh is available afterwards. Caption refresh does not change the playback URL or remount the main video.
- Embedded secondary video supports pointer dragging, 16:9 corner resizing, keyboard adjustments and reset. Validated normalized preferences use browser-local storage; close/reopen and view swaps retain them. Resize/fullscreen/caption changes reclamp the layout. Pointer events are isolated from main playback gestures; no OS floating window is used.

## Checks

- TypeScript: 3/3 focused tests (exclusive/idempotent request publication; automatic/manual/deferred/failed status boundaries; narrow/normal/fullscreen-area geometry). Zero network/model calls.
- Python control logic: 6/6 focused tests. The new queue test checks priority, existing checkpoints/attempts, active leases, failed-ledger stop, exact deferred time retention and stale-source rejection. Windows explicitly simulates only the unavailable `fcntl` primitive. The same six tests also passed in an isolated Linux directory with the real lock primitive; this is not a full installed-systemd integration result.
- Full type checking and targeted ESLint completed with no output; diff whitespace checks passed. Logs are in ignored `data/subtitle-button-*` files.
- A production application build succeeded with Webpack. Local Turbopack attempts were blocked by an external dependency junction and then sandbox IPC; neither failure is reported as an application pass. Linux CI remains the normal Turbopack/container verification gate.
- Real local HTTP, with normal owner login: 9/9 checks passed, including anonymous 401, wrong-origin 403, unknown view 404, arbitrary task parameters 400, oversize 413, duplicate pending request 202 without a second request or a root queue rewrite, and safe generation metadata 200. No ASR or AI was started by this local fixture.
- Actual authorized two-view browser playback: title-bar drag and 16:9 corner resize both changed the embedded view. Main playback stayed paused at the same position throughout both gestures. Close/reopen and page reload retained layout; swapping views retained layout and secondary mute. The local partial-subtitle button returned the visible disabled queued state, which survived reload.
- Fullscreen video/subtitle proportions and camera bounds were checked at 20% and 30% subtitle areas; the camera stayed above progress controls. Source-specific timestamps, measurements, private screenshots and machine receipts are retained locally and are not part of this public commit.

## Release prerequisites and limits

Install the updated root controller plus new `course-subtitle-request.service` and `.path`, then enable the path during the approved release. The installer now includes both units in its installed/restored-file inventory. Existing root requests mount is reused. Installing code alone does not activate the handler.

Generation is single-worker priority scheduling, not immediate parallel transcription. Failed jobs intentionally have no blind retry button: an administrator must inspect unknown charges/failed ledgers first. Unknown full-video duration remains conservatively partial. Full subtitle quality/coverage is unchanged by these controls.

Independent review found that an old source-unavailable preflight result could permanently block a restored original. This was corrected: an explicit retry may reach root source verification again, while actual failed queue jobs, active leases and future deferrals remain blocked. The focused status test covers both the recovered-source case and preservation of the paid-failure stop.

The camera helper reserves the rendered control and progress heights plus 16px, with a 64px minimum. It does not use the translated gradient plate as the measurement. Geometry tests cover supplied boundaries; the browser checks above provide the separate rendered-layout evidence. A real tablet/stylus and all browser fullscreen implementations have not been tested.

## Delivery state

- Code: implemented; commit and PR identify the exact reviewed revision.
- Tests: the focused, Linux, HTTP and browser checks above passed; full CI is reported separately on the PR. These are not subtitle-content or PDF-answer acceptance scores.
- Service deployment: not performed for this change; the new request handler still requires installation and path activation.
- Production switch: not performed; existing production remains unchanged.

Slide/transcript explanation research is separate from this change. No private course content, source hashes, signed URLs or provider credentials are included in this report or its synthetic test fixtures.
