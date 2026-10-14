#!/usr/bin/env bash
set -euo pipefail
postgres_container=${1:?PostgreSQL test container required}
vector_image=study-postgres:18.6-pgvector0.8.7
docker build -t "$vector_image" - < deploy/postgres-vector.Dockerfile
extension_container=$(docker create "$vector_image")
extension_dir=$(mktemp -d)
cleanup() {
  docker rm "$extension_container" >/dev/null
  rm -rf -- "$extension_dir"
}
trap cleanup EXIT
docker cp "$extension_container:/usr/lib/postgresql/18/lib/vector.so" "$extension_dir/vector.so"
docker cp "$extension_container:/usr/share/postgresql/18/extension/." "$extension_dir/"
docker cp "$extension_dir/vector.so" "$postgres_container:/usr/lib/postgresql/18/lib/vector.so"
docker exec "$postgres_container" mkdir -p /tmp/study-vector-extension
docker cp "$extension_dir/." "$postgres_container:/tmp/study-vector-extension/"
docker exec "$postgres_container" sh -c 'cp /tmp/study-vector-extension/vector.control /tmp/study-vector-extension/vector--*.sql /usr/share/postgresql/18/extension/; rm -rf /tmp/study-vector-extension'
docker exec "$postgres_container" psql -U study_kernel -d study_kernel -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; SELECT extversion FROM pg_extension WHERE extname='vector';"
