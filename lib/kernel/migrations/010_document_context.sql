-- Derived structure and images are evidence attachments to immutable PG versions.
-- They do not replace document heads, original bodies, or canonical facts.
CREATE TABLE document_structures (
 version_id text PRIMARY KEY REFERENCES document_text_versions(id),
 source_version_id text NOT NULL REFERENCES source_item_versions(id),
 source_hash text NOT NULL,
 raw_source_hash text NOT NULL,
 parser_version text NOT NULL,
 manifest_sha256 text NOT NULL,
 manifest jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE document_image_attachments (
 id text PRIMARY KEY,
 version_id text NOT NULL REFERENCES document_text_versions(id),
 source_version_id text NOT NULL REFERENCES source_item_versions(id),
 source_hash text NOT NULL,
 caption_evidence_id text NOT NULL REFERENCES evidence(id),
 asset_sha256 text NOT NULL CHECK (asset_sha256 ~ '^[a-f0-9]{64}$'),
 byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 52428800),
 width integer NOT NULL CHECK (width > 0),
 height integer NOT NULL CHECK (height > 0),
 mime text NOT NULL CHECK (mime = 'image/png'),
 original_reference text NOT NULL,
 provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(version_id,caption_evidence_id,asset_sha256,original_reference)
);
CREATE INDEX document_image_caption_idx ON document_image_attachments(version_id,caption_evidence_id);
