CREATE TABLE canvas_task_identity (
  course_id text NOT NULL REFERENCES courses(id),
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  action_index integer NOT NULL,
  entity_id text NOT NULL REFERENCES entities(id),
  PRIMARY KEY(course_id, reference_type, reference_id, action_index)
);

CREATE INDEX canvas_task_identity_entity_idx ON canvas_task_identity(entity_id);

CREATE TABLE canvas_task_separations (
  planner_source_item_id text NOT NULL REFERENCES source_items(id),
  action_index integer NOT NULL,
  planner_entity_id text NOT NULL REFERENCES entities(id),
  direct_entity_id text NOT NULL REFERENCES entities(id),
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(planner_source_item_id,action_index)
);

ALTER TABLE entities ADD COLUMN merged_into text REFERENCES entities(id);

CREATE TABLE task_entity_merges (
  source_entity_id text NOT NULL REFERENCES entities(id),
  target_entity_id text NOT NULL REFERENCES entities(id),
  source_task_id text NOT NULL,
  target_task_id text NOT NULL,
  action_index integer NOT NULL,
  source_status text NOT NULL,
  target_status_before text NOT NULL,
  added_fact_evidence jsonb NOT NULL DEFAULT '[]',
  copied_candidate_ids jsonb NOT NULL DEFAULT '[]',
  created_fact_ids jsonb NOT NULL DEFAULT '[]',
  actor text NOT NULL,
  reason text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by text,
  rollback_reason text,
  rollback_before_value jsonb,
  rollback_after_value jsonb,
  PRIMARY KEY(source_entity_id, applied_at)
);

CREATE UNIQUE INDEX task_entity_merges_active_idx ON task_entity_merges(source_entity_id)
  WHERE rolled_back_at IS NULL;
