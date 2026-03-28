-- Add source_url to memories — stores origin URL for url-import entries.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_url TEXT;
