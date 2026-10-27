-- Existing acquisition timestamps are not retroactively declared effective dates.
ALTER TABLE evidence ADD COLUMN validity_basis text NOT NULL DEFAULT 'unknown'
 CHECK (validity_basis IN ('explicit','published','observed','unknown'));
CREATE TABLE course_fact_validity_projection (
 fact_id text PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
 fact_version integer NOT NULL,
 evaluated_at timestamptz NOT NULL,
 refresh_kind text NOT NULL CHECK (refresh_kind IN ('hourly','daily')),
 validity jsonb NOT NULL
);
CREATE INDEX course_fact_visibility_idx ON entities(owner_id,course_id,kind);
