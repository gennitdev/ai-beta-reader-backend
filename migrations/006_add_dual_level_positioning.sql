-- Add dual-level positioning for chapters
-- This allows chapters to have both a global book position and a position within their part

-- Add the new position_in_part column
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS position_in_part INTEGER;

-- Drop the existing complex constraint
ALTER TABLE chapters DROP CONSTRAINT IF EXISTS unique_chapter_position;

-- Add new constraints for dual-level positioning
-- Global book ordering (unchanged)
ALTER TABLE chapters ADD CONSTRAINT unique_chapter_position_global
  UNIQUE(book_id, position);

-- Part-level ordering (only for chapters that are in parts)
ALTER TABLE chapters ADD CONSTRAINT unique_chapter_position_in_part
  UNIQUE(book_id, part_id, position_in_part);

-- Update existing chapters to have position_in_part values
-- For chapters already in parts, set position_in_part based on their current order within the part
WITH part_positions AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY book_id, part_id ORDER BY position) - 1 as new_position_in_part
  FROM chapters
  WHERE part_id IS NOT NULL
)
UPDATE chapters c
SET position_in_part = pp.new_position_in_part
FROM part_positions pp
WHERE c.id = pp.id;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_chapters_position_in_part ON chapters(book_id, part_id, position_in_part);