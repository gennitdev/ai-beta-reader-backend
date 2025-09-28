-- Add custom reviewer profiles table
CREATE TABLE custom_reviewer_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Ensure unique profile names per user
  UNIQUE(user_id, name)
);

-- Add index for efficient user profile lookups
CREATE INDEX idx_custom_reviewer_profiles_user_id ON custom_reviewer_profiles(user_id);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_custom_reviewer_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_custom_reviewer_profiles_updated_at
    BEFORE UPDATE ON custom_reviewer_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_custom_reviewer_profiles_updated_at();