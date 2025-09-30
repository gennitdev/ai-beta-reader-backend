-- Migration: Add Book Wiki System
-- Run this script to add wiki functionality to your database

-- Wiki Pages - stores the actual wiki content for each book
CREATE TABLE IF NOT EXISTS wiki_pages (
  id SERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_name TEXT NOT NULL,              -- e.g. "Sayana", "Vee", "Magic System"
  page_type TEXT DEFAULT 'character',   -- 'character', 'location', 'concept', 'other'
  content TEXT NOT NULL DEFAULT '',     -- The wiki page content (markdown)
  summary TEXT,                         -- Brief summary for quick reference
  aliases JSONB DEFAULT '[]'::jsonb,    -- Alternative names/spellings
  tags JSONB DEFAULT '[]'::jsonb,       -- Custom tags for organization
  is_major BOOLEAN DEFAULT false,       -- Is this a major character/element?
  created_by_ai BOOLEAN DEFAULT false,  -- Was this page created by AI?
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(book_id, page_name)            -- One page per name per book
);

-- Wiki Updates - audit log of all changes to wiki pages
CREATE TABLE IF NOT EXISTS wiki_updates (
  id SERIAL PRIMARY KEY,
  wiki_page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL, -- Which chapter triggered this update (if any)
  update_type TEXT NOT NULL,            -- 'created', 'updated', 'contradiction_noted', 'manual_edit'
  previous_content TEXT,                -- Content before the update
  new_content TEXT NOT NULL,            -- Content after the update
  change_summary TEXT,                  -- AI-generated summary of what changed
  contradiction_notes TEXT,             -- Notes about contradictions found
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chapter Wiki Mentions - tracks which characters/elements are mentioned in each chapter
CREATE TABLE IF NOT EXISTS chapter_wiki_mentions (
  id SERIAL PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  wiki_page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  mention_context TEXT,                 -- How they were mentioned in the chapter
  is_primary BOOLEAN DEFAULT false,     -- Is this character a primary focus of the chapter?
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(chapter_id, wiki_page_id)      -- One mention record per chapter per wiki page
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_wiki_pages_book ON wiki_pages(book_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_name ON wiki_pages(page_name);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_type ON wiki_pages(page_type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated ON wiki_pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_updates_page ON wiki_updates(wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_updates_chapter ON wiki_updates(chapter_id);
CREATE INDEX IF NOT EXISTS idx_wiki_updates_created ON wiki_updates(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_mentions_chapter ON chapter_wiki_mentions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_wiki_mentions_page ON chapter_wiki_mentions(wiki_page_id);

-- Verify the migration
SELECT 'Wiki migration complete! Created tables:' as message;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('wiki_pages', 'wiki_updates', 'chapter_wiki_mentions')
ORDER BY table_name;