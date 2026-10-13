-- Dense retrieval is a rebuildable index; page text and evidence stay canonical.
-- public is explicit because integration tests migrate into non-public schemas.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE document_page_embeddings
  ADD COLUMN embedding_vector public.vector(768)
  GENERATED ALWAYS AS (embedding::public.vector(768)) STORED;

-- Scope first, then exact cosine distance: no approximate recall tradeoff yet.
CREATE INDEX document_page_embeddings_owner_model_idx
  ON document_page_embeddings(owner_id,model,version_id);
