-- Rank complete source pages so relevant terms separated by chunk boundaries
-- still contribute to one page. The original body is never changed.
ALTER TABLE document_text_pages ADD COLUMN search_text text NOT NULL DEFAULT '';
UPDATE document_text_pages SET search_text=body;
ALTER TABLE document_text_pages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS
  (to_tsvector('english'::regconfig,search_text) || to_tsvector('simple'::regconfig,search_text)) STORED;
CREATE INDEX document_text_pages_fts_idx ON document_text_pages USING gin(search_vector);
