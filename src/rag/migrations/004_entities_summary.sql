-- Add summary fields to entities table
ALTER TABLE entities ADD COLUMN IF NOT EXISTS summary             TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS memory_count       INT NOT NULL DEFAULT 0;
