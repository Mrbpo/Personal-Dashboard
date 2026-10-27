-- Provenance for proposals in the existing candidate_facts review queue.
-- This table grants no authority and creates no canonical facts or tasks.
CREATE TABLE document_course_fact_candidates (
 candidate_id text PRIMARY KEY REFERENCES candidate_facts(id),
 owner_id text NOT NULL,
 document_id text NOT NULL REFERENCES document_texts(id),
 version_id text NOT NULL REFERENCES document_text_versions(id),
 source_version_id text NOT NULL REFERENCES source_item_versions(id),
 source_hash text NOT NULL,
 page_number integer NOT NULL CHECK(page_number > 0),
 page_evidence_id text NOT NULL REFERENCES evidence(id),
 body_sha256 text NOT NULL,
 start_utf16 integer NOT NULL CHECK(start_utf16 >= 0),
 end_utf16 integer NOT NULL CHECK(end_utf16 > start_utf16),
 parser_version text NOT NULL,
 extractor_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(version_id,page_number) REFERENCES document_text_pages(version_id,page_number)
);
CREATE INDEX document_course_fact_source_idx ON document_course_fact_candidates(owner_id,document_id,version_id);
