-- Add person_name to memories — mirrors the current JSON `person` field.
-- Used for entity profile queries without requiring a JOIN to entities.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS person_name TEXT;

CREATE INDEX IF NOT EXISTS memories_persona_person ON memories (persona_id, person_name)
  WHERE person_name IS NOT NULL;
