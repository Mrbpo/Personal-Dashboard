-- Optional AI ordering artifact. No AI facts or authoritative business state.
CREATE TABLE document_rerank_cache (
  owner_id text NOT NULL,
  cache_key text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  ordered_ids jsonb NOT NULL CHECK (jsonb_typeof(ordered_ids)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,cache_key,model,prompt_version)
);
