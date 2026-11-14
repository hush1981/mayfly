-- Every JWT carries the user's token_version; changing the password increments it, which
-- invalidates all older tokens at once (logout everywhere). Tokens from before this
-- migration carry no version (= 0) and stay valid until the first password change.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
