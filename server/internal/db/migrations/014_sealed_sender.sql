-- Sealed sender: friends deliver to a user with a random delivery token (given to them end-to-end
-- encrypted); the server only stores its SHA-256 hash and does not learn who sent a message.
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_token_hash BYTEA;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_delivery_token ON users(delivery_token_hash) WHERE delivery_token_hash IS NOT NULL;
-- sealed rows have no sender
ALTER TABLE relay_messages ALTER COLUMN sender_id DROP NOT NULL;
-- sealed moments: the sender is inside an encrypted header only the recipient can open;
-- unsending needs a secret only the sender knows (hash stored here)
ALTER TABLE media ADD COLUMN IF NOT EXISTS sealed_header BYTEA;
ALTER TABLE media ADD COLUMN IF NOT EXISTS unsend_hash BYTEA;
