CREATE TABLE canvas_planner_backfill_plans (
  plan_hash text PRIMARY KEY,
  candidate_count integer NOT NULL,
  manifest jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canvas_planner_backfill_windows (
  plan_hash text NOT NULL REFERENCES canvas_planner_backfill_plans(plan_hash),
  window_index integer NOT NULL,
  course_id text NOT NULL,
  start_on date NOT NULL,
  end_on date NOT NULL,
  source_ids jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','review','error','complete')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  result jsonb,
  completed_at timestamptz,
  PRIMARY KEY (plan_hash,window_index)
);
