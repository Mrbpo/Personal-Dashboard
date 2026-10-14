-- Recording subtitles share original-text evidence and FTS. The ordinal in the
-- legacy page_number column identifies a cue; its kind and actual time interval
-- make clear that this is not a PDF page. No task/event/fact projections change.
ALTER TABLE document_text_pages ADD COLUMN content_kind text NOT NULL DEFAULT 'page'
  CHECK(content_kind IN ('page','time_segment'));
ALTER TABLE document_text_pages ADD COLUMN start_ms bigint;
ALTER TABLE document_text_pages ADD COLUMN end_ms bigint;
ALTER TABLE document_text_pages ADD CONSTRAINT document_content_locator_check CHECK (
  (content_kind='page' AND start_ms IS NULL AND end_ms IS NULL) OR
  (content_kind='time_segment' AND start_ms>=0 AND end_ms>start_ms AND start_ms IS NOT NULL AND end_ms IS NOT NULL)
);
