CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    public_key BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
    addressee_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    ephemeral_public_key BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    media_type VARCHAR(10) NOT NULL,
    file_size BIGINT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    viewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_recipient_unviewed ON media(recipient_id, viewed_at) WHERE viewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_expires_at ON media(expires_at) WHERE viewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_friendships_addressee_status ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_lookup ON friendships(requester_id, addressee_id);
