# Server-local Codex maintenance

The production host runs Codex CLI in the dedicated `codexmaint` Linux account. It does not depend on the owner's Windows computer.

## Trigger model

This is event-driven, not a recurring nightly job. The website writes a bounded JSON task into `/app/data/codex-queue/incoming` when:

- the owner submits a manual maintenance request in Settings;
- an AI response receives negative feedback; or
- a background job reaches its terminal failed state after retries.

The host's `systemd.path` watcher sees the new file immediately and creates a one-shot run for 23:30 America/Toronto on the same day. Tasks arriving after 23:30 run shortly afterward. Multiple tasks are coalesced into one run. With no queued task, Codex does not run.

Codex uses `gpt-5.6-sol` with `model_reasoning_effort="medium"`. It runs as an unprivileged user in the workspace-write sandbox. A root-owned wrapper owns scheduling and validation; the model process cannot control systemd, Docker, production data, or deployment credentials.

## Change flow

Codex changes a private server checkout. The wrapper rejects private-file paths, then runs the full test suite, TypeScript checks, migration checks, and a production build. A successful change is pushed to a unique `codex/server-maintenance-*` branch. GitHub Actions validates it again and opens a reviewable pull request. Production remains protected by the existing versioned Release workflow.

The Codex API credential is read from `/etc/codex-maintenance.env`, mode `0600`, and is never stored in Git or in a task JSON file.
