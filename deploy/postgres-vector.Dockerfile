# Keep the existing PostgreSQL minor version and Debian ABI. Build without
# -march=native so a release artifact remains portable between server CPUs.
FROM postgres:18.6 AS vector-build
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apt-get update \
 && apt-get install --no-install-recommends -y build-essential ca-certificates curl postgresql-server-dev-18 \
 && curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/vector.tar.gz \
 && echo "${PGVECTOR_SHA256}  /tmp/vector.tar.gz" | sha256sum --check --strict \
 && mkdir /tmp/vector \
 && tar -xzf /tmp/vector.tar.gz --strip-components=1 -C /tmp/vector \
 && make -C /tmp/vector -j2 OPTFLAGS='' \
 && make -C /tmp/vector install DESTDIR=/vector-install \
 && rm -rf /var/lib/apt/lists/* /tmp/vector /tmp/vector.tar.gz

FROM postgres:18.6
COPY --from=vector-build /vector-install/usr/lib/postgresql/18/ /usr/lib/postgresql/18/
COPY --from=vector-build /vector-install/usr/share/postgresql/18/extension/ /usr/share/postgresql/18/extension/
