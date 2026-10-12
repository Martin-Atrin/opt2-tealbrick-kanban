-- 0.1.2 (QA S2): which (project, agent) pairs already got the shared-project access from the owner UI. Applied once
-- per pair, like the SDK's defaultGrants per (agent, type): a later owner edit (e.g. "No access") wins and is never
-- re-applied. Unsharing or deleting the project clears its pairs, so sharing it again applies them again.
CREATE TABLE share_grants (
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (project, agent)
);
