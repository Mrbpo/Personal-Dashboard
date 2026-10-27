-- Optional, unverified recall derivation. Original body/evidence/vectors and
-- native-table candidate search stay untouched. Old pages remain NULL.
ALTER TABLE document_text_pages ADD COLUMN search_hint_provenance jsonb;
ALTER TABLE document_text_pages ADD CONSTRAINT document_orig_search_hint_object CHECK
 (search_hint_provenance IS NULL OR
  (jsonb_typeof(search_hint_provenance)='object' AND
   search_hint_provenance->>'policy'='docling-orig-search-hints-v1' AND
   octet_length(search_hint_provenance::text)<=131072) IS TRUE);
