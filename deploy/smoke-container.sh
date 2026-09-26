#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the built image tag}"
network="study-smoke-$$"
database_container="${network}-postgres"
cleanup(){
  docker rm -f "$database_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The test web and worker can reach only this disposable database container.
docker network create --internal "$network" >/dev/null
docker run -d --rm --name "$database_container" --network "$network" \
  -e POSTGRES_DB=study_kernel -e POSTGRES_USER=study_kernel \
  -e POSTGRES_PASSWORD=smoke-password postgres:18.6 >/dev/null
ready=0
for _ in $(seq 1 30); do
  if docker exec "$database_container" pg_isready -U study_kernel -d study_kernel >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1

database_url="postgresql://study_kernel:smoke-password@$database_container:5432/study_kernel"
docker run --rm --network "$network" -e KERNEL_DATABASE_URL="$database_url" "$image" \
  node --experimental-strip-types scripts/kernel-migrate.ts
docker run --rm --network "$network" -e KERNEL_DATABASE_URL="$database_url" "$image" \
  node --experimental-strip-types scripts/smoke-production.mjs
