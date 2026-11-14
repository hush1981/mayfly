-- The friend list is ordered on the device now: the server no longer records when two
-- friends last exchanged a moment.
ALTER TABLE friendships DROP COLUMN IF EXISTS last_contact_at;
