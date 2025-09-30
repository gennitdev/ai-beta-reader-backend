-- Migration 007: Array-Based Chapter Ordering
-- Replace position fields with arrays of chapter IDs for cleaner, atomic ordering

-- Add chapter order arrays to books and parts
ALTER TABLE books ADD COLUMN IF NOT EXISTS chapter_order TEXT[] DEFAULT '{}';
ALTER TABLE book_parts ADD COLUMN IF NOT EXISTS chapter_order TEXT[] DEFAULT '{}';

-- Populate book chapter_order arrays from current position data
UPDATE books
SET chapter_order = (
  SELECT array_agg(c.id ORDER BY c.position, c.id)
  FROM chapters c
  WHERE c.book_id = books.id
)
WHERE chapter_order = '{}';

-- Populate part chapter_order arrays from current position_in_part data
UPDATE book_parts
SET chapter_order = (
  SELECT array_agg(c.id ORDER BY c.position_in_part, c.id)
  FROM chapters c
  WHERE c.part_id = book_parts.id AND c.position_in_part IS NOT NULL
)
WHERE chapter_order = '{}';

-- Remove position-based constraints and indexes
DROP INDEX IF EXISTS idx_chapters_position_in_part;
ALTER TABLE chapters DROP CONSTRAINT IF EXISTS unique_chapter_position_global;
ALTER TABLE chapters DROP CONSTRAINT IF EXISTS unique_chapter_position_in_part;
ALTER TABLE chapters DROP CONSTRAINT IF EXISTS unique_chapter_position;

-- Remove position fields from chapters
ALTER TABLE chapters DROP COLUMN IF EXISTS position;
ALTER TABLE chapters DROP COLUMN IF EXISTS position_in_part;

-- Remove part position constraints (parts don't need ordering between themselves)
ALTER TABLE book_parts DROP CONSTRAINT IF EXISTS book_parts_book_id_position_key;
ALTER TABLE book_parts DROP COLUMN IF EXISTS position;

-- Create indexes for array operations
CREATE INDEX IF NOT EXISTS idx_books_chapter_order ON books USING GIN (chapter_order);
CREATE INDEX IF NOT EXISTS idx_book_parts_chapter_order ON book_parts USING GIN (chapter_order);

-- Note: After this migration, chapter ordering will be managed entirely through
-- the chapter_order arrays in books and book_parts tables.
-- - books.chapter_order contains the global book ordering
-- - book_parts.chapter_order contains the ordering within each part