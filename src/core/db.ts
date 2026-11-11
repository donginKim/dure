import Database from 'better-sqlite3';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    UNIQUE (project_id, path)
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    name_locked INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped',
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    assignee TEXT NOT NULL DEFAULT 'agent',
    position INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX todos_by_project ON todos (project_id, workspace_id, position);
  CREATE TABLE todo_pending (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    line TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE project_flow (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    paused INTEGER NOT NULL DEFAULT 0,
    capped INTEGER NOT NULL DEFAULT 0,
    agent_streak INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    capped INTEGER NOT NULL DEFAULT 0,
    agent_streak INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- 워크스페이스가 지워져도 대화 기록은 남아야 하므로 워크스페이스에는 외래 키를 걸지 않는다.
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    from_workspace_id TEXT,
    to_workspace_id TEXT NOT NULL,
    body TEXT NOT NULL,
    artifact_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX messages_undelivered ON messages (to_workspace_id, delivered_at);
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    path TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE commit_drafts (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 에이전트를 돌리는 방식과, 이어갈 대화의 id. 이미 있던 Claude Code 워크스페이스도 채팅 방식으로 옮긴다.
  `
  ALTER TABLE workspaces ADD COLUMN engine TEXT NOT NULL DEFAULT 'terminal';
  ALTER TABLE workspaces ADD COLUMN session_id TEXT;
  UPDATE workspaces SET engine = 'chat' WHERE agent_kind = 'claude';
  `,
];

/** SQLite 파일을 열고 스키마를 최신으로 올린다. ':memory:' 도 된다. */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
