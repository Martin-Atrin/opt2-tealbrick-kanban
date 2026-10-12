-- 0.1.4 (QA S3): directory of app callers (companion grants), like `agents`, so issues, comments and activity by an
-- app show its display name. `name` is the SDK's verified caller name; NULL while the SDK knows only the instance id.
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT,
  last_seen INTEGER NOT NULL
);
