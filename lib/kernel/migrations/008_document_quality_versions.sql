-- Unchanged body text may acquire new warnings or extraction provenance.
-- Keep the original body hash and historical versions; source identity now
-- includes stable quality metadata and distinguishes these immutable revisions.
ALTER TABLE document_text_versions
  DROP CONSTRAINT document_text_versions_document_id_parser_version_text_hash_key;
ALTER TABLE document_text_versions
  ADD CONSTRAINT document_text_versions_quality_identity_key
  UNIQUE(document_id,parser_version,text_hash,source_version_id);
