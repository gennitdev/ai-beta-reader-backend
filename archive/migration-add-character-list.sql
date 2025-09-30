-- Migration: Add Book Character List for Cross-Linking
-- Run this script to add character tracking at the book level

-- Book Characters - master list of all characters mentioned in a book
CREATE TABLE IF NOT EXISTS book_characters (
  id SERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL,
  first_mentioned_chapter TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  mention_count INTEGER DEFAULT 1,
  has_wiki_page BOOLEAN DEFAULT false,
  wiki_page_id INTEGER REFERENCES wiki_pages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(book_id, character_name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_book_characters_book ON book_characters(book_id);
CREATE INDEX IF NOT EXISTS idx_book_characters_name ON book_characters(character_name);
CREATE INDEX IF NOT EXISTS idx_book_characters_wiki ON book_characters(wiki_page_id);

-- Update existing wiki pages to link back to book_characters
-- This will help us maintain consistency between the two tables
INSERT INTO book_characters (book_id, character_name, has_wiki_page, wiki_page_id)
SELECT
  wp.book_id,
  wp.page_name,
  true,
  wp.id
FROM wiki_pages wp
WHERE wp.page_type = 'character'
ON CONFLICT (book_id, character_name)
DO UPDATE SET
  has_wiki_page = true,
  wiki_page_id = EXCLUDED.wiki_page_id;

-- Verify the migration
SELECT 'Character list migration complete!' as message;
SELECT
  bc.character_name,
  bc.mention_count,
  bc.has_wiki_page,
  wp.page_name as wiki_page_name
FROM book_characters bc
LEFT JOIN wiki_pages wp ON bc.wiki_page_id = wp.id
ORDER BY bc.book_id, bc.character_name;