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
  `,  // 두레의 설정. 기본값과 다른 것만 담는다. 값은 JSON 이다.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 프로젝트 완료 처리와 "정리 대기" (최종 산출물이 아닌 파일을 지우지 않고 저장소 밖에 옮겨 둔 것).
  `
  ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE projects ADD COLUMN completed_at INTEGER;
  CREATE TABLE cleanup_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    workspace_name TEXT NOT NULL,
    path TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    reason TEXT NOT NULL,
    size INTEGER NOT NULL,
    is_dir INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 프로젝트 조율. 조율 에이전트는 role 이 coordinator 인 워크스페이스다: 저장소가 아니라 두레가 관리하는 폴더에서 돈다.
  // 워크스페이스는 저장소를 가리켜야 하므로, 그 폴더를 화면에 보이지 않는 내부 저장소(internal)로 적어 둔다.
  `
  ALTER TABLE repos ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workspaces ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    items TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE db_connections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database TEXT NOT NULL DEFAULT '',
    user TEXT NOT NULL,
    ssl INTEGER NOT NULL DEFAULT 0,
    agent_access TEXT NOT NULL DEFAULT 'ask',
    secret TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  `,
  `
  -- 다른 사람의 두레와 연결
  CREATE TABLE peer_identity (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pub TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'review',
    direct INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_peer TEXT NOT NULL,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE share_members (
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    peer_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'member',
    -- 이 프로젝트에서 그 사람의 열쇠와 주소 (연 사람이 나눠 준 것). 비어 있으면 내가 직접 연결한 열쇠를 쓴다
    pub TEXT,
    address TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (share_id, peer_id)
  );
  CREATE TABLE workspace_sharing (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    audience TEXT NOT NULL,
    peers TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE remote_workspaces (
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    peer_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    listed INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (share_id, peer_id, workspace_id)
  );
  -- 이미 받은 내용의 id (같은 것을 다시 보내오면 버린다. 껐다 켜도 남는다)
  CREATE TABLE peer_replay (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE peer_inbox (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    from_peer TEXT NOT NULL,
    from_workspace TEXT NOT NULL,
    -- 비어 있으면 워크스페이스가 아니라 나(사용자)에게 온 질문이다
    to_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    thread TEXT NOT NULL,
    artifacts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- 배정: 계획안의 일을 함께하는 사람에게 나눠 주기
  CREATE TABLE assignments_out (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    peer_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'sent',
    progress TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE assignments_in (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_peer TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    workspaces TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- 슬랙 읽기: 연결은 하나다 (사용자의 토큰). 토큰은 암호화해 둔다
  CREATE TABLE slack_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT '',
    user TEXT NOT NULL DEFAULT '',
    access TEXT NOT NULL DEFAULT 'ask',
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- 메모: 프로젝트와 상관없이 쓰는 사용자의 메모장
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX notes_updated ON notes (updated_at DESC);
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
