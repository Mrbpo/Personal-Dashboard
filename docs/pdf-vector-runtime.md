# PDF dense retrieval runtime

Issue #55. PostgreSQL remains the truth layer; vectors are rebuildable page indexes.

## Pinned extension and CPU behavior

- `pgvector` source **v0.8.7**, archive SHA-256 `cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85`.
- Both build and runtime use **postgres:18.6**, matching the existing server minor version and Debian ABI.
- Compile with `OPTFLAGS=''`, avoiding machine-specific `-march=native`. This retains the compiler's portable optimization and pgvector's runtime CPU dispatch where supported; it does not promise AVX-512 on an unspecified virtual CPU.
- Do not change the PostgreSQL minor version as part of adding vector retrieval.
- Migration 007 stores a generated `public.vector(768)` alongside the existing validated `double precision[]` cache. Existing inserts and cache rebuilding continue to work.
- Query with `OPERATOR(public.<=>)` and `public.vector` when using an isolated schema search path. The extension is installed once per database in `public`, not once per test schema.
- The owner/model/version B-tree scopes exact cosine search. No HNSW or IVFFlat in this phase: 1,865 pages are small enough to measure exact retrieval before accepting approximation.

Official references: [pgvector installation, portability and exact search](https://github.com/pgvector/pgvector), [PostgreSQL Docker image](https://hub.docker.com/_/postgres).

## Building and deployment order

Build without sending application data, credentials or backup files as Docker context:

```sh
docker build -t study-postgres:18.6-pgvector0.8.7 - < deploy/postgres-vector.Dockerfile
```

The release builds this image before its PostgreSQL tests and transfers it with the application image in the existing restricted Docker-image stream. The receiver checks that it is available, stops writers and verifies the one pre-switch backup before recreating PostgreSQL or running migration 007. `deploy/compose.yml` references this local, pinned version label.

Before the first vector release, the server administrator must install the reviewed `compose.yml` and `receive.sh` into their existing root-owned paths. They are host configuration, not files silently changed by the application image. Later daily backup restarts must use this same PostgreSQL image. Check the compressed two-image artifact against the existing 2 GiB transfer cap during the release build.

A temporary install into a running stock PostgreSQL container is suitable only for isolated acceptance. Its files disappear when the container is recreated. It is **not a deployed or recoverable runtime**. Production rollout requires the immutable image, controlled PostgreSQL recreation using its existing volume, health checks, and the existing backup/switch procedure. Do not let a backup job recreate PostgreSQL from the old stock image after the extension has become a production dependency.

CI builds this exact Dockerfile, copies only `vector.so`, `vector.control` and versioned vector SQL into its disposable PostgreSQL service, then verifies extension creation before tests. CI does not reboot that service or substitute a different PostgreSQL minor version.

## Isolated server acceptance

The current production PostgreSQL process must remain running. A builder container may compile the extension against the same stock image. Copy its extension files into `/usr/lib/postgresql/18/lib` and `/usr/share/postgresql/18/extension` only after coordinator confirmation. Create the extension **only in `pdf_acceptance_20261006`** and apply migration 007 only there. Do not read production credentials or query private source contents.

Verify actual PostgreSQL version, extension version, generated column dimensions and cosine calculation. Keep a report distinguishing image built, isolated extension installed and production deployment; these are separate states.

## CPU measurements

Measure concurrency **1, 2 and 4** on the public corpus using cached query/page vectors. Record p50/p95 latency, completed queries/second, errors, PostgreSQL/container CPU peak, RSS and available host memory. Use both API entry points for the final user-facing latency check; a dense SQL scan alone excludes query embedding, lexical fusion and external reranking time.

Run an idle-parser measurement first. A parser-active measurement is optional only if the remaining resource risk warrants it. Avoid re-transcribing completed PDFs to manufacture load. Keep web and QQ resource availability as the constraint, not a target of 100% CPU utilization. Query concurrency normally starts at 2, then compare 4 against actual tail latency and service health.

The ignored `data/pdf-heldout/runtime/benchmark-vector-cpu.mjs` measures only the exact SQL stage against current public page vectors. Its report explicitly excludes embedding and reranking. Refuse any database other than the isolated acceptance database and never make paid calls from this benchmark.

## Status

- Runtime files: implemented. The actual server build on 2026-10-13 produced image `sha256:b562446771a2916c73abaabd782e0dbbf49cb0be420a5fe43a3a5beeccc6d384` using PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`.
- Isolated runtime: `pdf_acceptance_20261006` reports `vector 0.8.7` in `public`; a temporary generated 768-dimensional vector computed self cosine `1` with `search_path=pg_temp` and the explicit public operator. The probe was rolled back. PostgreSQL's original start time remained `2026-10-12T06:25:28.62226781Z`, with its running image still `postgres:18.6`.
- The official `pgvector/pgvector:0.8.7-pg18` tag was also pulled and inspected: digest `sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11`, PostgreSQL 18.6 on Debian pgdg12. Its extension was not copied across to the running pgdg13 container.
- Three-group accuracy: reported separately after actual hybrid retrieval.
- Production vector runtime: **not deployed** until the controlled release confirms the image and real read/write behavior.
