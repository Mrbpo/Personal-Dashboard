-- Source-derived PDF assets anchor genuine pages, independently of author captions.
-- A single immutable row publishes the complete staged manifest atomically.
CREATE TABLE document_pdf_visual_manifests (
 version_id text PRIMARY KEY REFERENCES document_text_versions(id),
 source_version_id text NOT NULL REFERENCES source_item_versions(id),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
