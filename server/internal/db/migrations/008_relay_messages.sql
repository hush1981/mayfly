-- Opaque, end-to-end encrypted client-to-client messages (read receipts, replay/save events).
-- The server only sees sender, recipient and an encrypted blob; rows are deleted when the
-- recipient acknowledges them, or after 24 hours at the latest.
CREATE TABLE IF NOT EXISTS relay_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ephemeral_public_key BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    payload BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relay_recipient ON relay_messages(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relay_created ON relay_messages(created_at);
