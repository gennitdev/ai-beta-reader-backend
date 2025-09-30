-- AI Beta Reader Database Schema
-- Run this once in your Neon console or any SQL client
-- Updated schema based on current database structure after migrations

-- Users table to store Auth0 user data
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  auth0_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  username TEXT,
  name TEXT,
  picture TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Books table for user's writing projects
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Book parts for organizing chapters into sections
CREATE TABLE IF NOT EXISTS book_parts (
  id SERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chapters table for individual chapters
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT,
  text TEXT NOT NULL,
  word_count INTEGER,
  position INTEGER,
  part_id INTEGER REFERENCES book_parts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chapter summaries for AI context
CREATE TABLE IF NOT EXISTS chapter_summaries (
  chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  pov TEXT,
  characters JSONB,
  beats JSONB,
  spoilers_ok BOOLEAN,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Wiki pages for characters, locations, and world-building
CREATE TABLE IF NOT EXISTS wiki_pages (
  id SERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_name TEXT NOT NULL,
  page_type TEXT NOT NULL,
  content TEXT,
  summary TEXT,
  is_auto_generated BOOLEAN DEFAULT FALSE,
  auto_generated_content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Wiki page update history
CREATE TABLE IF NOT EXISTS wiki_updates (
  id SERIAL PRIMARY KEY,
  wiki_page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chapter to wiki page mentions for cross-references
CREATE TABLE IF NOT EXISTS chapter_wiki_mentions (
  id SERIAL PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  wiki_page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(chapter_id, wiki_page_id)
);

-- Book characters extracted from wiki pages
CREATE TABLE IF NOT EXISTS book_characters (
  id SERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  relationships JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI profiles for different reviewer personalities
CREATE TABLE IF NOT EXISTS ai_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tone_key TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tone_key)
);

-- Custom reviewer profiles (legacy table for user-created profiles)
CREATE TABLE IF NOT EXISTS custom_reviewer_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chapter reviews storage
CREATE TABLE IF NOT EXISTS chapter_reviews (
  id SERIAL PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  ai_profile_id INTEGER NOT NULL REFERENCES ai_profiles(id) ON DELETE CASCADE,
  review_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(chapter_id, ai_profile_id)
);

-- Helpful indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_auth0_sub ON users(auth0_sub);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_books_user_id ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_book_parts_book_id ON book_parts(book_id);
CREATE INDEX IF NOT EXISTS idx_book_parts_position ON book_parts(book_id, position);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_chapters_position ON chapters(book_id, position);
CREATE INDEX IF NOT EXISTS idx_chapters_part_id ON chapters(part_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON chapter_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_book_id ON wiki_pages(book_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_type ON wiki_pages(page_type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_name ON wiki_pages(page_name);
CREATE INDEX IF NOT EXISTS idx_wiki_updates_page_id ON wiki_updates(wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_chapter_wiki_mentions_chapter ON chapter_wiki_mentions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_chapter_wiki_mentions_wiki ON chapter_wiki_mentions(wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_book_characters_book_id ON book_characters(book_id);
CREATE INDEX IF NOT EXISTS idx_ai_profiles_user ON ai_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_profiles_tone ON ai_profiles(tone_key);
CREATE INDEX IF NOT EXISTS idx_custom_profiles_user ON custom_reviewer_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_chapter ON chapter_reviews(chapter_id);
CREATE INDEX IF NOT EXISTS idx_reviews_profile ON chapter_reviews(ai_profile_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON chapter_reviews(created_at DESC);

-- Create a system user for default AI profiles
INSERT INTO users (auth0_sub, email, email_verified, name) VALUES
('system', 'system@ai-beta-reader.com', true, 'System')
ON CONFLICT (auth0_sub) DO NOTHING;

-- Insert default system AI profiles
INSERT INTO ai_profiles (user_id, name, tone_key, system_prompt, is_system)
SELECT u.id, p.name, p.tone_key, p.system_prompt, p.is_system
FROM users u, (VALUES
  ('Fanfic review style', 'fanficnet', 'You are a thoughtful, enthusiastic serial reader. React to THIS new chapter in context of prior summaries. 2–5 short paragraphs; warm, specific; reference arcs/payoffs; no spoilers beyond prior summaries.', true),
  ('Editorial Notes', 'editorial', 'You are a concise developmental editor. Give specific, actionable notes about structure, character, pacing, and continuity for THIS chapter in context.', true),
  ('Line Editor', 'line-notes', 'You are a line editor. Provide concrete line-level suggestions with examples.', true)
) AS p(name, tone_key, system_prompt, is_system)
WHERE u.auth0_sub = 'system'
ON CONFLICT (user_id, tone_key) DO NOTHING;