CREATE TABLE IF NOT EXISTS kernel_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kernel_imports (
  name text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS academic_terms (
  id text PRIMARY KEY,
  name text NOT NULL,
  starts_on date,
  ends_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id text PRIMARY KEY,
  term_id text REFERENCES academic_terms(id),
  name text NOT NULL,
  code text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entities (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL,
  course_id text REFERENCES courses(id),
  term_id text REFERENCES academic_terms(id),
  identity_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, kind, identity_key)
);

CREATE TABLE IF NOT EXISTS source_status (
  source text NOT NULL,
  scope text NOT NULL,
  cursor_value text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error text,
  state text NOT NULL DEFAULT 'idle',
  PRIMARY KEY(source, scope)
);

CREATE TABLE IF NOT EXISTS source_items (
  id text PRIMARY KEY,
  source text NOT NULL,
  scope text NOT NULL,
  external_id text NOT NULL,
  source_url text,
  course_id text REFERENCES courses(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','missing')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  missing_at timestamptz,
  UNIQUE(source, scope, external_id)
);

CREATE TABLE IF NOT EXISTS source_item_versions (
  id text PRIMARY KEY,
  source_item_id text NOT NULL REFERENCES source_items(id),
  content_hash text NOT NULL,
  raw_value jsonb NOT NULL,
  raw_uri text,
  raw_sha256 text,
  published_at timestamptz,
  remote_updated_at timestamptz,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_item_id, content_hash)
);

CREATE TABLE IF NOT EXISTS evidence (
  id text PRIMARY KEY,
  source_version_id text NOT NULL REFERENCES source_item_versions(id),
  source text NOT NULL,
  source_item_id text NOT NULL,
  acquired_at timestamptz NOT NULL,
  published_at timestamptz,
  original_excerpt text NOT NULL,
  parsed_value jsonb NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from timestamptz,
  valid_to timestamptz,
  locator text,
  UNIQUE(source_version_id, locator)
);

CREATE TABLE IF NOT EXISTS facts (
  id text PRIMARY KEY,
  entity_id text NOT NULL REFERENCES entities(id),
  attribute text NOT NULL,
  canonical_value jsonb NOT NULL,
  chosen_candidate_id text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_id, attribute)
);

CREATE TABLE IF NOT EXISTS candidate_facts (
  id text PRIMARY KEY,
  entity_id text NOT NULL REFERENCES entities(id),
  attribute text NOT NULL,
  value jsonb NOT NULL,
  evidence_id text NOT NULL REFERENCES evidence(id),
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  reason text,
  authority text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(entity_id, attribute, evidence_id)
);

CREATE TABLE IF NOT EXISTS fact_versions (
  id bigserial PRIMARY KEY,
  fact_id text NOT NULL REFERENCES facts(id),
  version integer NOT NULL,
  value jsonb NOT NULL,
  candidate_id text NOT NULL REFERENCES candidate_facts(id),
  reason text NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(fact_id, version)
);

CREATE TABLE IF NOT EXISTS fact_evidence (
  fact_id text NOT NULL REFERENCES facts(id),
  evidence_id text NOT NULL REFERENCES evidence(id),
  candidate_id text NOT NULL REFERENCES candidate_facts(id),
  PRIMARY KEY(fact_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  entity_id text NOT NULL UNIQUE REFERENCES entities(id),
  course_id text NOT NULL REFERENCES courses(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_url text,
  title text NOT NULL,
  action text NOT NULL,
  requirements jsonb NOT NULL DEFAULT '[]',
  start_at timestamptz,
  due_date date,
  due_at timestamptz,
  due_local_time time,
  due_timezone text,
  due_precision text CHECK (due_precision IN ('date','hour','minute','second')),
  due_original text,
  unlock_at timestamptz,
  lock_at timestamptz,
  canvas_status text NOT NULL DEFAULT 'open',
  local_status text NOT NULL DEFAULT 'active',
  source_missing boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  urgency text NOT NULL DEFAULT 'upcoming',
  confidence text NOT NULL DEFAULT 'certain',
  evidence_excerpt text NOT NULL DEFAULT '',
  estimated_minutes integer,
  points_possible numeric,
  prerequisite_blocked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at IS NULL OR (due_date IS NOT NULL AND due_timezone IS NOT NULL AND due_precision <> 'date'))
);
CREATE INDEX IF NOT EXISTS tasks_course_due_idx ON tasks(course_id,due_at,due_date);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  entity_id text NOT NULL UNIQUE REFERENCES entities(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  source_name text NOT NULL,
  external_uid text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_name,external_uid)
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  source text NOT NULL,
  scope text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','complete','failed')),
  stage text NOT NULL DEFAULT 'fetching',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx ON ingestion_jobs(state,available_at,lease_until);

CREATE TABLE IF NOT EXISTS kernel_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  last_error text,
  idempotency_key text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS adjudications (
  id bigserial PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidate_facts(id),
  actor text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept','reject')),
  reason text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
