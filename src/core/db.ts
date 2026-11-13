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
  `
  -- 사용량: 모델의 답 하나마다 쓴 토큰 수 (대화 기록에서 읽는다). 워크스페이스가 지워져도 남긴다
  CREATE TABLE token_usage (
    message_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX token_usage_project ON token_usage (project_id, at);
  `,
  `
  -- 되돌리기 지점: 워크스페이스의 작업 폴더를 그때의 모습으로 되돌릴 수 있게 적어 둔 것
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'auto',
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    tree_sha TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX checkpoints_ws ON checkpoints (workspace_id, created_at);
  `,
  `
  -- PR 초안: 에이전트가 적어 두면 사용자가 고쳐서 PR 을 만든다
  CREATE TABLE pr_drafts (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- 받은 기획서 정리: 프로젝트를 연 사람이 함께하는 사람 모두에게 보낸 것. 사용자가 자료로 받거나 버린다
  CREATE TABLE briefs_in (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_peer TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- 근무시간: 근무지의 네트워크에 붙어 있던 구간. day 는 이 PC 의 시간대로 본 날짜
  CREATE TABLE work_sessions (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL
  );
  CREATE INDEX work_sessions_day ON work_sessions (day, start_at);
  -- 근무지로 기억해 둔 네트워크 (공유기의 MAC 주소로 알아본다)
  CREATE TABLE work_networks (gateway TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  `,
  `
  -- 출퇴근 기록: 아직 퇴근하지 않은 구간(open)과, 퇴근을 누르지 않아 두레가 닫은 구간(auto)
  ALTER TABLE work_sessions ADD COLUMN open INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE work_sessions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- 그날의 휴게 시간 (분). 사용자가 달력에서 적는다. 근무시간에서 뺀다
  CREATE TABLE work_breaks (day TEXT PRIMARY KEY, minutes INTEGER NOT NULL);
  `,
  `
  -- 워크스페이스 TODO 가 딸린 프로젝트 TODO. 딸린 항목이 다 끝나면 프로젝트 항목이 저절로 완료된다
  ALTER TABLE todos ADD COLUMN parent_id TEXT;
  CREATE INDEX todos_by_parent ON todos (parent_id);
  `,
  `
  -- 받은 현황판: 함께하는 프로젝트를 연 사람이 보낸 큰 일과 담당표. 프로젝트마다 가장 새 것 하나
  CREATE TABLE boards_in (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    from_peer TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  `,
  `
  -- 참여자가 제안한 계획안을 받는 방식 (프로젝트를 연 사람이 정한다): review 검토 뒤 승인, auto 승인 없이 반영
  ALTER TABLE shares ADD COLUMN suggest_mode TEXT NOT NULL DEFAULT 'review';
  -- 내가 리더에게 보낸 계획 제안: 결과 알림을 한 번만 받는다
  CREATE TABLE suggestions_out (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- 저장소의 확인 명령 (사용자가 정한다) 과, 워크스페이스마다의 마지막 확인 결과
  ALTER TABLE repos ADD COLUMN verify_command TEXT NOT NULL DEFAULT '';
  CREATE TABLE verifications (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    tree TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  `,
  `
  -- 일의 순서: todo_id 는 after_id 가 끝난 뒤에 시작한다
  CREATE TABLE todo_deps (
    todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    after_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    PRIMARY KEY (todo_id, after_id)
  );
  CREATE INDEX todo_deps_after ON todo_deps (after_id);
  `,
  `
  -- 워크스페이스마다의 모델 (비어 있으면 설정의 모델). 에이전트가 도는 중에도 바꿀 수 있다
  ALTER TABLE workspaces ADD COLUMN model TEXT NOT NULL DEFAULT '';
  `,
  `
  -- 커밋 전의 리뷰 (리뷰 에이전트가 찾은 것). 워크스페이스마다 마지막 하나
  CREATE TABLE reviews (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    tree TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    findings TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
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
