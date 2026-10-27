-- Keep native PDF declarations distinct from fallible author-image observations.
ALTER TABLE document_table_candidates ADD COLUMN source_kind text NOT NULL DEFAULT 'pdf-page';
ALTER TABLE document_table_candidates ADD COLUMN attachment_id text REFERENCES document_image_attachments(id);
ALTER TABLE document_table_candidates DROP CONSTRAINT document_table_candidates_check;
ALTER TABLE document_table_candidates ADD CONSTRAINT document_table_candidates_source_binding CHECK (
 (source_kind='pdf-page' AND producer='docling-native-table-v1' AND attachment_id IS NULL
  AND (status='unavailable' OR (page_number>0 AND anchor_evidence_id IS NOT NULL
   AND manifest_sha256 IS NOT NULL AND asset_sha256 IS NOT NULL AND raw_result_sha256 IS NOT NULL
   AND input_sha256 IS NOT NULL AND options_sha256 IS NOT NULL)))
 OR
 (source_kind='author-caption-image' AND producer='visible-table-grid-v1'
  AND page_number IS NULL AND manifest_sha256 IS NULL AND options_sha256 IS NULL
  AND attachment_id IS NOT NULL AND anchor_evidence_id IS NOT NULL AND asset_sha256 IS NOT NULL
  AND raw_result_sha256 IS NOT NULL AND input_sha256 IS NOT NULL)
);
