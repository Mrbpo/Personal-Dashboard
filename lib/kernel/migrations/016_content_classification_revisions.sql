-- Classification proposals/corrections are derived indexes, never core facts.
CREATE TABLE document_content_classifications (
 id text PRIMARY KEY,
 owner_id text NOT NULL,
 document_id text NOT NULL,
 version_id text NOT NULL,
 source_version_id text NOT NULL,
 source_hash text NOT NULL,
 taxonomy_version text NOT NULL,
 classifier_id text NOT NULL,
 producer_version text NOT NULL,
 method text NOT NULL CHECK(method IN ('manual','rule','model')),
 model text,
 previous_id text,
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 assignments jsonb NOT NULL CHECK(jsonb_typeof(assignments)='array' AND jsonb_array_length(assignments)<=64),
 unknown_facets text[] NOT NULL,
 actor text NOT NULL CHECK(length(btrim(actor))>0),
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 filter_authorization boolean NOT NULL DEFAULT false CHECK(NOT filter_authorization),
 semantic_verified boolean NOT NULL DEFAULT false CHECK(NOT semantic_verified),
 coverage text NOT NULL DEFAULT 'explicit-scopes-only' CHECK(coverage='explicit-scopes-only'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((method='model')=(model IS NOT NULL)),
 FOREIGN KEY(document_id,owner_id,source_hash) REFERENCES document_texts(id,owner_id,source_hash),
 FOREIGN KEY(version_id,document_id,source_version_id) REFERENCES document_text_versions(id,document_id,source_version_id),
 UNIQUE(id,owner_id,version_id,classifier_id),
 FOREIGN KEY(previous_id,owner_id,version_id,classifier_id)
  REFERENCES document_content_classifications(id,owner_id,version_id,classifier_id)
);
CREATE TABLE document_content_classification_heads (
 owner_id text NOT NULL,
 version_id text NOT NULL,
 classifier_id text NOT NULL,
 classification_id text NOT NULL,
 PRIMARY KEY(owner_id,version_id,classifier_id),
 FOREIGN KEY(classification_id,owner_id,version_id,classifier_id)
  REFERENCES document_content_classifications(id,owner_id,version_id,classifier_id)
);
CREATE INDEX document_content_classification_document ON document_content_classifications(owner_id,document_id,version_id);
CREATE INDEX document_content_classification_tags ON document_content_classifications USING gin(assignments jsonb_path_ops);
