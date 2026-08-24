-- A header for an agent that needs one.
--
-- Stored server-side and never returned by any read path. A builder's token is
-- theirs; the browser has no reason to hold it, and a secret that reaches the
-- client is a secret that has been published.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_header text;
