-- Migration to add prompt_used column to chapter_reviews table
-- This stores the full prompt that was sent to the AI to generate the review

ALTER TABLE chapter_reviews
  ADD COLUMN prompt_used TEXT;

-- Add comment to explain the purpose
COMMENT ON COLUMN chapter_reviews.prompt_used IS 'Stores the full prompt that was sent to the AI to generate this review, for debugging and transparency';