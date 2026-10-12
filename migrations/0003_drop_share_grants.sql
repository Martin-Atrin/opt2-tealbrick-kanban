-- 0.1.3: SDK 0.1.13 gives the `shared` default grant to every already-seen agent when a project becomes shared
-- (Kanban QA S2 fixed in the SDK), so the owner-UI share sync and its record table are gone.
DROP TABLE share_grants;
