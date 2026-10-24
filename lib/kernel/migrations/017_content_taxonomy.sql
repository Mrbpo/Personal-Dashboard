CREATE TABLE content_taxonomy_revisions (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 owner_id text NOT NULL,
 taxonomy_version text NOT NULL,
 previous_id text,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 actor text NOT NULL,
 reason text NOT NULL,
 semantic_verified boolean NOT NULL DEFAULT false CHECK(semantic_verified=false),
 filter_authorization boolean NOT NULL DEFAULT false CHECK(filter_authorization=false),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,previous_id) REFERENCES content_taxonomy_revisions(owner_id,id),
 CHECK(previous_id IS NULL OR previous_id<>id)
);
CREATE TABLE content_taxonomy_heads (
 owner_id text PRIMARY KEY,
 revision_id text NOT NULL,
 FOREIGN KEY(owner_id,revision_id) REFERENCES content_taxonomy_revisions(owner_id,id)
);
