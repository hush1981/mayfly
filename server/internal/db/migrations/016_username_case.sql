-- Usernames are unique regardless of case: "Anna" and "anna" must not be two accounts
-- (one could pose as the other in friend requests). Existing names keep their spelling.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
