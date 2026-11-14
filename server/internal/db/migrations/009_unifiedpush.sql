-- ntfy topic/server/token are replaced by a single UnifiedPush endpoint chosen on the device.
-- The old ntfy settings are deleted (data minimisation), not migrated.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_endpoint TEXT;
ALTER TABLE users DROP COLUMN IF EXISTS ntfy_topic;
ALTER TABLE users DROP COLUMN IF EXISTS ntfy_token;
ALTER TABLE users DROP COLUMN IF EXISTS ntfy_server;
