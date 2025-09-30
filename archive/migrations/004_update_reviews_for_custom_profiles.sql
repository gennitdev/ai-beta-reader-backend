-- Migration to support custom reviewer profiles in chapter_reviews table
-- This allows reviews to be associated with either AI profiles OR custom reviewer profiles

-- Make ai_profile_id nullable since custom reviews won't have an ai_profile
ALTER TABLE chapter_reviews
  ALTER COLUMN ai_profile_id DROP NOT NULL;

-- Add column for custom reviewer profile reference
ALTER TABLE chapter_reviews
  ADD COLUMN custom_profile_id INTEGER REFERENCES custom_reviewer_profiles(id) ON DELETE CASCADE;

-- Add check constraint to ensure either ai_profile_id OR custom_profile_id is set (but not both)
ALTER TABLE chapter_reviews
  ADD CONSTRAINT check_profile_type CHECK (
    (ai_profile_id IS NOT NULL AND custom_profile_id IS NULL) OR
    (ai_profile_id IS NULL AND custom_profile_id IS NOT NULL)
  );

-- Drop and recreate the unique constraint to include custom_profile_id
ALTER TABLE chapter_reviews
  DROP CONSTRAINT chapter_reviews_chapter_id_ai_profile_id_key;

-- Create new unique constraint that handles both types of profiles
CREATE UNIQUE INDEX chapter_reviews_unique_review ON chapter_reviews (
  chapter_id,
  COALESCE(ai_profile_id::text, 'custom-' || custom_profile_id::text)
);