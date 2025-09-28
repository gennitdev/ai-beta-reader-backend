-- Add book parts table
CREATE TABLE IF NOT EXISTS book_parts (
  id SERIAL PRIMARY KEY,
  book_id VARCHAR(255) NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(book_id, position)
);

-- Add ordering and part reference to chapters
ALTER TABLE chapters
ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS part_id INTEGER REFERENCES book_parts(id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_book_parts_book_id ON book_parts(book_id);
CREATE INDEX IF NOT EXISTS idx_chapters_part_id ON chapters(part_id);
CREATE INDEX IF NOT EXISTS idx_chapters_position ON chapters(position);
CREATE INDEX IF NOT EXISTS idx_chapters_book_position ON chapters(book_id, position);

-- Add unique constraint to prevent duplicate positions within a book/part
ALTER TABLE chapters DROP CONSTRAINT IF EXISTS unique_chapter_position;
ALTER TABLE chapters ADD CONSTRAINT unique_chapter_position
  UNIQUE(book_id, part_id, position);

-- Update existing chapters to have sequential positions
WITH numbered_chapters AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY created_at) - 1 as new_position
  FROM chapters
)
UPDATE chapters c
SET position = nc.new_position
FROM numbered_chapters nc
WHERE c.id = nc.id AND c.position = 0;