-- Rebuildable native parser hints; never original evidence or canonical truth.
CREATE TABLE document_table_candidates (
 id text PRIMARY KEY,
 namespace text NOT NULL,
 producer text NOT NULL,
 document_id text NOT NULL REFERENCES document_texts(id),
 version_id text NOT NULL REFERENCES document_text_versions(id),
 source_version_id text NOT NULL REFERENCES source_item_versions(id),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 page_number integer,
 anchor_evidence_id text REFERENCES evidence(id),
 manifest_sha256 text,
 asset_sha256 text,
 raw_result_sha256 text,
 input_sha256 text,
 options_sha256 text,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('available','unavailable')),
 unavailable_reason text,
 artifact jsonb NOT NULL,
 search_text text NOT NULL,
 search_vector tsvector GENERATED ALWAYS AS
  (to_tsvector('english',search_text)||to_tsvector('simple',search_text)) STORED,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status='unavailable' OR (page_number>0 AND anchor_evidence_id IS NOT NULL
  AND manifest_sha256 IS NOT NULL AND asset_sha256 IS NOT NULL AND raw_result_sha256 IS NOT NULL
  AND input_sha256 IS NOT NULL AND options_sha256 IS NOT NULL))
);
CREATE INDEX document_table_candidates_search_idx ON document_table_candidates USING gin(search_vector) WHERE status='available';
CREATE INDEX document_table_candidates_version_idx ON document_table_candidates(version_id);
