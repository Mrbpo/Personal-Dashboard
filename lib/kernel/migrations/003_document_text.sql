-- Parsed content is versioned evidence, not a canonical task/date fact.
CREATE TABLE document_texts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  course_id text REFERENCES courses(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  origin text NOT NULL,
  origin_key text NOT NULL,
  name text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  current_version_id text,
  hidden boolean NOT NULL DEFAULT false,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE document_text_versions (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES document_texts(id),
  source_version_id text NOT NULL REFERENCES source_item_versions(id),
  parser_version text NOT NULL,
  text_hash text NOT NULL,
  page_count integer NOT NULL CHECK (page_count > 0),
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,parser_version,text_hash)
);
ALTER TABLE document_texts ADD CONSTRAINT document_text_current_version_fk
  FOREIGN KEY(current_version_id) REFERENCES document_text_versions(id);
CREATE TABLE document_text_pages (
  version_id text NOT NULL REFERENCES document_text_versions(id),
  page_number integer NOT NULL CHECK (page_number > 0),
  evidence_id text NOT NULL REFERENCES evidence(id),
  locator text NOT NULL,
  body text NOT NULL,
  PRIMARY KEY(version_id,page_number)
);
CREATE TABLE document_text_chunks (
  id text PRIMARY KEY,
  version_id text NOT NULL,
  page_number integer NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  body text NOT NULL,
  search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english'::regconfig,search_text) || to_tsvector('simple'::regconfig,search_text)) STORED,
  FOREIGN KEY(version_id,page_number) REFERENCES document_text_pages(version_id,page_number),
  UNIQUE(version_id,position)
);
CREATE INDEX document_text_owner_course_idx ON document_texts(owner_id,course_id) WHERE hidden=false;
CREATE INDEX document_text_chunks_version_idx ON document_text_chunks(version_id,page_number);
CREATE INDEX document_text_chunks_fts_idx ON document_text_chunks USING gin(search_vector);
