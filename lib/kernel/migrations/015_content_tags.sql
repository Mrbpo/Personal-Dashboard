-- 013/014 are reserved by the independent PDF source/API work in PR186.
-- Observations only: no update of courses, tasks, facts or original content.
ALTER TABLE document_texts ADD CONSTRAINT document_tag_owner_source_identity UNIQUE(id,owner_id,source_hash);
ALTER TABLE document_text_versions ADD CONSTRAINT document_tag_version_identity UNIQUE(id,document_id,source_version_id);
CREATE TABLE document_tag_sets (
 id text PRIMARY KEY,
 owner_id text NOT NULL,
 document_id text NOT NULL,
 version_id text NOT NULL,
 source_version_id text NOT NULL,
 source_hash text NOT NULL,
 taxonomy_version text NOT NULL,
 producer text NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 classification_sha256 text NOT NULL CHECK(classification_sha256 ~ '^[a-f0-9]{64}$'),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 tags jsonb NOT NULL CHECK(jsonb_typeof(tags)='array' AND jsonb_array_length(tags)<=32),
 unknown_facets text[] NOT NULL,
 coverage text NOT NULL DEFAULT 'source-metadata-only' CHECK(coverage='source-metadata-only'),
 semantic_verified boolean NOT NULL DEFAULT false CHECK(NOT semantic_verified),
 filter_authorization boolean NOT NULL DEFAULT false CHECK(NOT filter_authorization),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(document_id,owner_id,source_hash) REFERENCES document_texts(id,owner_id,source_hash),
 FOREIGN KEY(version_id,document_id,source_version_id) REFERENCES document_text_versions(id,document_id,source_version_id),
 UNIQUE(version_id,taxonomy_version,producer,input_sha256)
);
CREATE INDEX document_tag_sets_owner_version ON document_tag_sets(owner_id,version_id);
CREATE INDEX document_tag_sets_tags ON document_tag_sets USING gin(tags jsonb_path_ops);
