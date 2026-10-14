-- Rebuildable semantic caches; original pages and evidence remain authoritative.
CREATE TABLE document_page_embeddings (
  owner_id text NOT NULL,
  version_id text NOT NULL,
  page_number integer NOT NULL,
  model text NOT NULL,
  input_hash text NOT NULL,
  embedding double precision[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,version_id,page_number,model,input_hash),
  FOREIGN KEY(version_id,page_number) REFERENCES document_text_pages(version_id,page_number) ON DELETE CASCADE,
  CHECK (array_ndims(embedding)=1 AND cardinality(embedding)=768
    AND array_position(embedding,NULL) IS NULL
    AND array_position(embedding,'NaN'::double precision) IS NULL
    AND array_position(embedding,'Infinity'::double precision) IS NULL
    AND array_position(embedding,'-Infinity'::double precision) IS NULL)
);
CREATE TABLE document_query_embeddings (
  owner_id text NOT NULL,
  query_hash text NOT NULL,
  model text NOT NULL,
  embedding double precision[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,query_hash,model),
  CHECK (array_ndims(embedding)=1 AND cardinality(embedding)=768
    AND array_position(embedding,NULL) IS NULL
    AND array_position(embedding,'NaN'::double precision) IS NULL
    AND array_position(embedding,'Infinity'::double precision) IS NULL
    AND array_position(embedding,'-Infinity'::double precision) IS NULL)
);
