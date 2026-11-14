-- Stories: one encrypted blob per story, readable for 24 hours by the friends the owner
-- picked. The server only stores, per allowed viewer, an end-to-end encrypted envelope
-- with the blob's key — it never sees the key or the content.
CREATE TABLE IF NOT EXISTS stories (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    file_size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_owner ON stories(owner_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);

CREATE TABLE IF NOT EXISTS story_keys (
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    envelope BYTEA NOT NULL,
    PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_story_keys_viewer ON story_keys(viewer_id);
