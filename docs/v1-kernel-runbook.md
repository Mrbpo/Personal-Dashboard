# v1 kernel deployment and cutover

This branch lives in `D:\Desktop\Files\canvas-study-dashboard-v1`, a worktree of the existing GitHub repository. The v0 checkout and running release remain separate until a verified cutover. The Compose and scripts in this branch are deployment instructions, not evidence that any service is running.

PostgreSQL owns courses, terms, tasks, events, source status, entities and canonical facts. SQLite remains in use for original Gmail/Piazza content, search chunks and vectors, PDF annotations, sketchbooks, settings, feedback and AI-derived mail analysis indexes. Those mail indexes are retrieval aids, not canonical entities or task/event state. The backup includes the entire SQLite file and its original blobs so none of these retained stores is omitted.

Canvas announcement and planner feeds are requested for a moving date window. Their absence from a later window is not treated as source deletion. Optional Canvas endpoint failures mark the scan incomplete, retain the previous source state and retry the job.

## Required host state

- Install Docker Engine/Compose, `age`, AWS CLI, and enough disk for a complete PostgreSQL restore, the local encrypted archive, and a temporary downloaded copy for offsite readback.
- Install the reviewed v1 `deploy/compose.yml`, `backup.sh`, `verify-backup.sh`, `verify-offsite-backup.sh`, `daily-backup.sh` and `receive.sh` as root-owned files under `/srv/study`. Keep their permissions restricted from the app user.
- Create `/srv/study/kernel-postgres-password` (0600) and set `KERNEL_DATABASE_URL=postgresql://study_kernel:<URL-encoded password>@postgres:5432/study_kernel` in `/srv/study/runtime.env` (0600). The password must match the file; neither belongs in Git or an image.
- Set `S3_BUCKET`, `S3_ENDPOINT` (HTTPS) and optionally `S3_PREFIX` plus AWS credentials in `/srv/study/backup-s3.env` (0600). Give this account write/read only to the backup prefix. Configure retention at the object store separately.
- Keep `/srv/study/backup.recipient` as the public age recipient. Keep `/srv/study/backup.identity` root-only for restore verification and an independent offline copy of that private key. The private key is not inside its own encrypted archive.
- Install the root-owned `study-kernel-backup.service` and `study-kernel-backup.timer` under `/etc/systemd/system`, enable the timer, and inspect its first successful run. A script alone does not schedule daily backups.
- After copying the units, run `systemctl daemon-reload`, `systemctl enable --now study-kernel-backup.timer`, `systemctl list-timers study-kernel-backup.timer`, and a supervised `systemctl start study-kernel-backup.service`. Confirm the offsite object and restore result before relying on the schedule.
- PostgreSQL and Docling expose no host port. The app uses `DOCLING_URL=http://docling:5001` on the Compose network. Docling uses the official CPU image at v1.35.0 with a 2 GiB (`2147483648` byte) memory limit on the 4 GB CPU-only host. A synthetic PDF converted within this limit; capacity for complex PDFs remains unverified and needs production acceptance. Review memory and disk headroom before pulling the image.

## Deployment sequence

1. Merge an approved PR into `main`, run CI with a real PostgreSQL service, and publish the normal release only when its tag points to the reviewed commit. A merge alone does not deploy.
2. The release receiver loads the image, starts PostgreSQL and Docling, applies versioned kernel migrations, and records `services_deployed` only after a real PostgreSQL health check. The v0 web and worker are still running at this point.
3. The receiver stops v0 writers, creates and uploads an encrypted backup of PostgreSQL, SQLite, original blobs, assets and recovery configuration, then verifies a local decryption and disposable-database restore. It downloads that same encrypted archive and SHA sidecar from offsite storage and compares their SHA and bytes with the locally verified archive before importing the final v0 core snapshot. A failed readback takes the existing before-cutover rollback path; the downloaded archive is not unpacked a second time. Import records a completion marker so later releases do not replay old task status.
4. The receiver starts v1 web and worker and checks the website, both databases, the worker heartbeat and Docling. Only successful checks record `production_switched`. A failure after v1 starts is reported as `blocked_after_cutover`; the script never silently starts a v0 writer against divergent data.
5. `verify-backup.sh` checks file hashes and SQLite integrity, verifies referenced original blobs, and restores the PostgreSQL dump into a disposable database. The receiver's readback confirms offsite object retrieval and byte identity; separately perform a full restore on an isolated host before declaring disaster recovery tested.

Before cutover, compare date-only deadlines in the API (`dueDate` and `duePrecision: date`) with the existing calendar in the configured timezone. The kernel does not invent a clock time for these deadlines. A wrong day or hour in the unchanged UI blocks production acceptance and needs a separately scoped rendering fix.

## Manual fact review

Use a named administrator shell with `KERNEL_DATABASE_URL` set. `npm run kernel:review -- list`, `show <candidate-id>`, `link <candidate-id> <task-id> "reason"`, `accept <candidate-id> "reason"`, and `reject <candidate-id> "reason"` read and write through `KernelService`. Link an unassigned mail claim before accepting it as a task deadline. The reason and OS actor are stored with the prior and selected values. AI mail claims, ambiguous dates and cancellation claims stay pending until reviewed. A missing source never constitutes cancellation.

For a maintenance-window projection repair, stop web and worker writers, run `npm run kernel:migrate -- --rebuild-projections`, compare the returned counts with the prior snapshot, and then restart writers. This rebuilds course, task and event projections from PostgreSQL canonical facts and evidence; it does not import SQLite again.

## Delivery evidence

Report four independent states: code complete (commit and PR), tests passed (CI run and restore exercise), services deployed (actual container IDs and health output), and production switched (live kernel reads/writes, final parity checks and release status). If credentials, server capacity, approval or restore verification are missing, label the affected state **blocked** and name the missing item. Do not infer deployment from this runbook or Compose files.
