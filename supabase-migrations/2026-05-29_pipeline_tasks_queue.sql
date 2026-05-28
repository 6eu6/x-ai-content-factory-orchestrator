-- ═══════════════════════════════════════════════════════════════
-- Pipeline Tasks Queue — Durable task queue for worker architecture
-- Additive migration only: CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS
-- ═══════════════════════════════════════════════════════════════

-- ═══ 1. Create pipeline_tasks table ═══
CREATE TABLE IF NOT EXISTS pipeline_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  step_order INT NOT NULL,
  account_handle TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL DEFAULT '{}',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  error_stack TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ 2. Indexes for pipeline_tasks ═══
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_run_id ON pipeline_tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_status ON pipeline_tasks(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_task_type ON pipeline_tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_step_order ON pipeline_tasks(step_order);
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_locked_at ON pipeline_tasks(locked_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_account_handle ON pipeline_tasks(account_handle);

-- Composite index for queue locking: find next eligible task efficiently
CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_queue_lock
  ON pipeline_tasks(status, step_order, created_at)
  WHERE status IN ('queued', 'running');

-- RLS for pipeline_tasks
ALTER TABLE pipeline_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on pipeline_tasks" ON pipeline_tasks
  FOR ALL USING (true) WITH CHECK (true);

-- ═══ 3. Add columns to pipeline_runs if missing ═══

-- total_tasks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'total_tasks'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN total_tasks INT DEFAULT 0;
  END IF;
END $$;

-- completed_tasks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'completed_tasks'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN completed_tasks INT DEFAULT 0;
  END IF;
END $$;

-- failed_tasks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'failed_tasks'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN failed_tasks INT DEFAULT 0;
  END IF;
END $$;

-- cancelled_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'cancelled_at'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN cancelled_at TIMESTAMPTZ;
  END IF;
END $$;

-- worker_mode
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'worker_mode'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN worker_mode TEXT;
  END IF;
END $$;

-- result_payload
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'result_payload'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN result_payload JSONB DEFAULT '{}';
  END IF;
END $$;

-- cancel_reason
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_runs' AND column_name = 'cancel_reason'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN cancel_reason TEXT;
  END IF;
END $$;
