-- Migration: Add AI Profiles and Chapter Reviews
-- Run this script to add the new tables to your existing database

-- Create a system user for default AI profiles if it doesn't exist
INSERT INTO users (auth0_sub, email, email_verified, name) VALUES
('system', 'system@ai-beta-reader.com', true, 'System')
ON CONFLICT (auth0_sub) DO NOTHING;

-- AI Profiles for different reviewer personalities
CREATE TABLE IF NOT EXISTS ai_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- e.g. "Fanfic review style", "Editorial Notes"
  tone_key TEXT NOT NULL,               -- e.g. "fanficnet", "editorial", "line-notes"
  system_prompt TEXT NOT NULL,          -- The prompt sent to OpenAI
  is_default BOOLEAN DEFAULT FALSE,     -- User's default profile
  is_system BOOLEAN DEFAULT FALSE,      -- Built-in system profiles (cannot be deleted)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tone_key)
);

-- Chapter Reviews storage
CREATE TABLE IF NOT EXISTS chapter_reviews (
  id SERIAL PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  ai_profile_id INTEGER NOT NULL REFERENCES ai_profiles(id) ON DELETE CASCADE,
  review_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(chapter_id, ai_profile_id)     -- One review per chapter per AI profile
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_profiles_user ON ai_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_profiles_tone ON ai_profiles(tone_key);
CREATE INDEX IF NOT EXISTS idx_reviews_chapter ON chapter_reviews(chapter_id);
CREATE INDEX IF NOT EXISTS idx_reviews_profile ON chapter_reviews(ai_profile_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON chapter_reviews(created_at DESC);

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

-- Verify the migration
SELECT 'Migration complete! Created tables:' as message;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('ai_profiles', 'chapter_reviews')
ORDER BY table_name;

-- Show the default AI profiles
SELECT 'Default AI profiles created:' as message;
SELECT name, tone_key, is_system FROM ai_profiles WHERE is_system = true;