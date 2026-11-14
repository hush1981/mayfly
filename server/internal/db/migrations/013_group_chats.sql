-- Group chats next to the existing broadcast lists ("Rundlisten").
--   kind 'list': the old groups — a moment goes to every member one by one, owner manages members.
--   kind 'chat': a shared chat; members are invited and must accept (status 'invited' → 'member'),
--                name and picture can be changed by every member.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'list';
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_kind_check;
ALTER TABLE groups ADD CONSTRAINT groups_kind_check CHECK (kind IN ('list', 'chat'));

ALTER TABLE group_memberships ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'member';
ALTER TABLE group_memberships DROP CONSTRAINT IF EXISTS group_memberships_status_check;
ALTER TABLE group_memberships ADD CONSTRAINT group_memberships_status_check CHECK (status IN ('invited', 'member'));
ALTER TABLE group_memberships ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- A photo / video / voice message in a group chat: one encrypted blob for everybody (the key
-- travels end-to-end encrypted to each member). It is deleted once every recipient opened it,
-- or after 24 hours.
CREATE TABLE IF NOT EXISTS group_media (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio')),
    file_size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_media_expires ON group_media(expires_at);
CREATE INDEX IF NOT EXISTS idx_group_media_group ON group_media(group_id);

CREATE TABLE IF NOT EXISTS group_media_pending (
    media_id UUID NOT NULL REFERENCES group_media(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_media_pending_user ON group_media_pending(user_id);
