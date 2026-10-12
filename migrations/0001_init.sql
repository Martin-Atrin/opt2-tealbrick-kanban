-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK. Times are epoch ms.

-- Workspace agent directory (manifest needsAgentDirectory), kept by events.agentAdded/agentRemoved: assignee names.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL
);

-- A project is also the scope instance (type `project`) with the same id. An agent's own project has id = agent id.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  shared INTEGER NOT NULL DEFAULT 0,
  owner_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  horizon TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX goals_by_project ON goals (project, created_at);

-- status: backlog | todo | in_progress | in_review | blocked | done (one vocabulary; "ready" is computed).
-- assignee_kind: agent | owner | NULL. created_by_*: the verified caller (agent, app or the owner).
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_kind TEXT,
  assignee_id TEXT,
  goal TEXT,
  blocked_reason TEXT,
  result TEXT,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX issues_by_project ON issues (project, status);
CREATE INDEX issues_by_assignee ON issues (assignee_id, status);

-- `issue` waits for `depends_on` (same project; no cycles).
CREATE TABLE issue_links (
  issue TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue, depends_on)
);
CREATE INDEX issue_links_reverse ON issue_links (depends_on);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_by_issue ON comments (issue, created_at);

-- Knowledge document references: id + title only, never the body.
CREATE TABLE issue_documents (
  issue TEXT NOT NULL,
  document TEXT NOT NULL,
  title TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (issue, document)
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  issue TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX activity_by_project ON activity (project, created_at DESC, id DESC);
CREATE INDEX activity_by_issue ON activity (issue, created_at DESC, id DESC);
