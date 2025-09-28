-- AI Beta Reader Database Schema
-- Run this once in your Neon console or any SQL client

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,           -- e.g. "ch-12"
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT,
  text TEXT NOT NULL,
  word_count INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapter_summaries (
  chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  pov TEXT,
  characters JSONB,
  beats JSONB,
  spoilers_ok BOOLEAN,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON chapter_summaries(created_at DESC);