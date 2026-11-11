import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type { Artifact, ArtifactKind, Message, ProjectFlow, Sender, Thread } from '@shared/types';

/** 사용자 개입 없이 에이전트끼리 주고받을 수 있는 메시지 수. 넘으면 전달을 멈추고 사용자에게 알린다. */
export const THREAD_CAP = 10;
export const PROJECT_CAP = 50;
/** 메시지 본문의 최대 길이. 긴 내용은 자료로 올리게 한다. */
export const MAX_BODY = 20_000;
const MAX_TITLE = 120;
// from_workspace_id 에 넣는 표시: NULL 은 사용자, 이 값은 두레 자신.
const SYSTEM = '@system';
// delivered_at 에 넣는 표시: 받는 워크스페이스가 지워져 전달하지 못함.
const FAILED = -1;

interface ThreadRow { id: string; project_id: string; title: string; paused: number; capped: number; agent_streak: number; created_at: number; updated_at: number }
interface MessageRow {
  id: string; thread_id: string; project_id: string; from_workspace_id: string | null; to_workspace_id: string;
  body: string; artifact_ids: string; created_at: number; delivered_at: number | null;
}
interface ArtifactRow { id: string; project_id: string; workspace_id: string | null; kind: string; title: string; body: string; path: string | null; created_at: number }

const toThread = (r: ThreadRow): Thread => ({
  id: r.id, projectId: r.project_id, title: r.title, paused: r.paused === 1, capped: r.capped === 1,
  agentStreak: r.agent_streak, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id, threadId: r.thread_id, projectId: r.project_id,
  from: r.from_workspace_id === null ? { kind: 'user' }
    : r.from_workspace_id === SYSTEM ? { kind: 'system' } : { kind: 'workspace', workspaceId: r.from_workspace_id },
  toWorkspaceId: r.to_workspace_id, body: r.body, artifactIds: JSON.parse(r.artifact_ids) as string[],
  createdAt: r.created_at, deliveredAt: r.delivered_at === FAILED ? null : r.delivered_at, failed: r.delivered_at === FAILED,
});
const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, kind: r.kind as ArtifactKind,
  title: r.title, body: r.body, path: r.path, createdAt: r.created_at,
});

// 본문과 제목은 받는 에이전트의 터미널에 써 넣어질 수 있다. 제어 문자는 저장하지 않는다 (줄바꿈 제외).
// 유니코드 줄 구분 문자도 지운다: 줄을 나눠 "[두레]" 로 시작하는 줄을 만드는 데 쓰일 수 있다.
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\x00-\x09\x0b-\x1f\x7f\u0085\u2028\u2029]/g, '');
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/;

/**
 * 한 줄로 만든다. 전달 글에서 본문(인용됨) 말고 나머지 값은 모두 이것을 거친다:
 * 줄바꿈이 남으면 "[두레]" 로 시작하는 줄을 끼워 넣어 두레나 사용자의 말을 사칭할 수 있다.
 */
const oneLine = (s: string, max = 200): string => clean(s).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * 받는 에이전트에게 전달하는 글.
 * 본문은 줄마다 "> " 를 붙여 인용한다: 본문에 "[두레] …" 가 적혀 있어도 두레의 말로 읽히지 않게 한다.
 */
export function formatDelivery(m: Message, d: { fromName: string; artifacts: Artifact[] }): string {
  const head = m.from.kind === 'user' ? `[두레] 사용자가 대화에 남긴 말이다. (스레드 ${m.threadId})`
    : m.from.kind === 'system' ? `[두레] 두레가 알린다. (스레드 ${m.threadId})`
      : `[두레] 워크스페이스 "${oneLine(d.fromName).replace(/"/g, '')}" 이(가) 보낸 메시지다. (스레드 ${m.threadId})`;
  const attachments = d.artifacts.length === 0 ? [] : [
    '첨부 자료:',
    ...d.artifacts.map((a) => (a.path ? `- ${oneLine(a.title)} → ${oneLine(a.path, 1000)}` : `- ${oneLine(a.title)} (artifact_read 로 읽기: ${a.id})`)),
  ];
  return [
    head,
    ...m.body.split('\n').map((line) => `> ${line}`),
    ...attachments,
    `답하려면 message_send 에 thread_id "${m.threadId}" 를 넣어라. 답이 필요 없으면 보내지 마라.`,
  ].join('\n');
}

/**
 * 워크스페이스 사이의 메시지, 스레드, 공유 자료의 원본.
 * 전달을 막는 조건(사용자 멈춤, 상한)은 여기서 판정하고, 실제 전달은 DeliveryService 가 한다.
 * 이벤트: 'changed' (projectId), 'sent' (message), 'released' (projectId: 붙잡혀 있던 것이 풀림)
 */
export class MessageService extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  private ensureFlow(projectId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO project_flow (project_id) VALUES (?)').run(projectId);
  }

  flow(projectId: string): ProjectFlow {
    const r = this.db.prepare('SELECT * FROM project_flow WHERE project_id = ?').get(projectId) as
      { paused: number; capped: number; agent_streak: number } | undefined;
    return { paused: r?.paused === 1, capped: r?.capped === 1, agentStreak: r?.agent_streak ?? 0 };
  }

  send(i: { projectId: string; from: Sender; toWorkspaceId: string; body: string; threadId?: string; artifactIds?: string[] }): Message {
    const body = clean(i.body).trim();
    if (!body) throw new Error('메시지 내용을 입력하세요.');
    if (body.length > MAX_BODY) throw new Error(`메시지가 너무 깁니다 (최대 ${MAX_BODY}자). 긴 내용은 artifact_publish 로 자료로 올리고 붙여라.`);
    for (const id of i.artifactIds ?? []) {
      if (this.artifact(id)?.projectId !== i.projectId) throw new Error(`이 프로젝트의 자료가 아닙니다: ${id}`);
    }
    const recipient = this.db.prepare('SELECT id FROM workspaces WHERE id = ? AND project_id = ?').get(i.toWorkspaceId, i.projectId);
    if (!recipient) throw new Error('받는 워크스페이스가 없습니다.');
    if (i.from.kind === 'workspace' && i.from.workspaceId === i.toWorkspaceId) throw new Error('자기 자신에게는 보낼 수 없습니다.');
    if (i.threadId) {
      const t = this.thread(i.threadId);
      if (!t || t.projectId !== i.projectId) throw new Error('이 프로젝트의 스레드가 아닙니다.');
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const threadId = i.threadId ?? crypto.randomUUID();
    const fromAgent = i.from.kind === 'workspace';
    const fromUser = i.from.kind === 'user';
    this.db.transaction(() => {
      this.ensureFlow(i.projectId);
      if (!i.threadId) {
        this.db.prepare('INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(threadId, i.projectId, body.split('\n')[0].slice(0, 60), now, now);
      }
      this.db.prepare(
        `INSERT INTO messages (id, thread_id, project_id, from_workspace_id, to_workspace_id, body, artifact_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, threadId, i.projectId, i.from.kind === 'workspace' ? i.from.workspaceId : fromUser ? null : SYSTEM, i.toWorkspaceId, body,
        JSON.stringify(i.artifactIds ?? []), now);
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, threadId);
      if (fromAgent) {
        // 메시지는 저장하되, 상한을 넘으면 전달을 멈춘다. 버리지 않는다.
        this.db.prepare('UPDATE threads SET agent_streak = agent_streak + 1, capped = (agent_streak + 1 > ?) WHERE id = ?').run(THREAD_CAP, threadId);
        this.db.prepare('UPDATE project_flow SET agent_streak = agent_streak + 1, capped = (agent_streak + 1 > ?) WHERE project_id = ?').run(PROJECT_CAP, i.projectId);
      } else if (fromUser) {
        this.liftCaps(i.projectId);
      }
    })();
    const message = this.message(id)!;
    this.emit('changed', i.projectId);
    this.emit('sent', message);
    if (fromUser) this.emit('released', i.projectId);
    return message;
  }

  private liftCaps(projectId: string): void {
    this.ensureFlow(projectId);
    this.db.prepare('UPDATE project_flow SET agent_streak = 0, capped = 0 WHERE project_id = ?').run(projectId);
    this.db.prepare('UPDATE threads SET agent_streak = 0, capped = 0 WHERE project_id = ?').run(projectId);
  }

  /** 사용자가 직접 개입했다: 왕복 횟수를 다시 세고 상한을 푼다. 사용자가 일부러 멈춘 것은 그대로 둔다. */
  userIntervened(projectId: string): void {
    const before = this.flow(projectId);
    const hadCappedThread = this.db.prepare('SELECT 1 FROM threads WHERE project_id = ? AND (capped = 1 OR agent_streak > 0) LIMIT 1').get(projectId);
    this.liftCaps(projectId);
    if (before.capped || before.agentStreak > 0 || hadCappedThread) {
      this.emit('changed', projectId);
      this.emit('released', projectId);
    }
  }

  private message(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return r && toMessage(r);
  }

  threads(projectId: string): Thread[] {
    return (this.db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC').all(projectId) as ThreadRow[]).map(toThread);
  }

  thread(id: string): Thread | undefined {
    const r = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return r && toThread(r);
  }

  messages(threadId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(threadId) as MessageRow[]).map(toMessage);
  }

  private pendingRows(workspaceId: string, blocked: boolean): MessageRow[] {
    // blocked: 사용자 멈춤이나 상한 때문에 전달이 막힌 것
    const cond = '(t.paused = 1 OR t.capped = 1 OR COALESCE(f.paused, 0) = 1 OR COALESCE(f.capped, 0) = 1)';
    return this.db.prepare(
      `SELECT m.* FROM messages m
         JOIN threads t ON t.id = m.thread_id
         LEFT JOIN project_flow f ON f.project_id = m.project_id
        WHERE m.to_workspace_id = ? AND m.delivered_at IS NULL AND ${blocked ? cond : `NOT ${cond}`}
        ORDER BY m.seq`,
    ).all(workspaceId) as MessageRow[];
  }

  /** 지금 전달해도 되는 미전달 메시지. 오래된 것이 먼저. */
  undelivered(workspaceId: string): Message[] {
    return this.pendingRows(workspaceId, false).map(toMessage);
  }

  /** 멈춤이나 상한으로 붙잡혀 있는 미전달 메시지 수 */
  heldCount(workspaceId: string): number {
    return this.pendingRows(workspaceId, true).length;
  }

  markDelivered(ids: string[]): void {
    this.setDelivered(ids, Date.now());
  }

  /** 전달하려다 실패했을 때 되돌린다. */
  unmarkDelivered(ids: string[]): void {
    this.setDelivered(ids, null);
  }

  private setDelivered(ids: string[], at: number | null): void {
    if (ids.length === 0) return;
    const set = this.db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) set.run(at, id); })();
    const projectId = this.message(ids[0])?.projectId;
    if (projectId) this.emit('changed', projectId);
  }

  pauseThread(id: string, paused: boolean): void {
    const t = this.thread(id);
    if (!t) throw new Error(`스레드가 없습니다: ${id}`);
    this.db.prepare('UPDATE threads SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
    this.emit('changed', t.projectId);
    if (!paused) this.emit('released', t.projectId);
  }

  pauseProject(projectId: string, paused: boolean): void {
    this.ensureFlow(projectId);
    this.db.prepare('UPDATE project_flow SET paused = ? WHERE project_id = ?').run(paused ? 1 : 0, projectId);
    this.emit('changed', projectId);
    if (!paused) this.emit('released', projectId);
  }

  /**
   * 워크스페이스가 지워진다. 그쪽으로 가던 미전달 메시지는 지우지 않고 "전달 못 함" 으로 남기고,
   * 답을 기다리고 있을 보낸 워크스페이스에 알린다. 워크스페이스 행을 지우기 전에 부른다.
   */
  removeWorkspace(workspaceId: string, name: string): void {
    const row = this.db.prepare('SELECT project_id FROM workspaces WHERE id = ?').get(workspaceId) as { project_id: string } | undefined;
    const lost = this.db.prepare(
      `SELECT thread_id, from_workspace_id, count(*) AS n FROM messages
        WHERE to_workspace_id = ? AND delivered_at IS NULL GROUP BY thread_id, from_workspace_id`,
    ).all(workspaceId) as { thread_id: string; from_workspace_id: string | null; n: number }[];
    this.db.transaction(() => {
      this.db.prepare('UPDATE messages SET delivered_at = ? WHERE to_workspace_id = ? AND delivered_at IS NULL').run(FAILED, workspaceId);
      this.db.prepare('UPDATE artifacts SET workspace_id = NULL WHERE workspace_id = ?').run(workspaceId);
    })();
    if (!row) return;
    for (const l of lost) {
      // 사용자가 보낸 것은 화면에서 보이므로 알리지 않는다. 지워지는 워크스페이스 자신에게도 알리지 않는다.
      if (l.from_workspace_id === null || l.from_workspace_id === SYSTEM || l.from_workspace_id === workspaceId) continue;
      try {
        this.send({
          projectId: row.project_id, from: { kind: 'system' }, toWorkspaceId: l.from_workspace_id, threadId: l.thread_id,
          body: `받는 워크스페이스 "${oneLine(name).replace(/"/g, '')}" 이(가) 지워져 메시지 ${l.n}건이 전달되지 않았다.`,
        });
      } catch { /* 보낸 쪽도 이미 없다 */ }
    }
    this.emit('changed', row.project_id);
  }

  publish(i: { projectId: string; workspaceId: string; kind: ArtifactKind; title: string; body?: string; path?: string }): Artifact {
    const title = oneLine(i.title, MAX_TITLE);
    if (!title) throw new Error('자료 제목을 입력하세요.');
    const body = i.body ?? '';
    const path = i.path?.trim() || null;
    if (!body && !path) throw new Error('자료에는 본문이나 파일 경로가 있어야 합니다.');
    if (path && !isAbsolute(path)) throw new Error('파일 경로는 절대 경로여야 합니다.');
    if (path && HAS_CONTROL.test(path)) throw new Error('파일 경로에 줄바꿈이나 제어 문자가 있으면 안 됩니다.');
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO artifacts (id, project_id, workspace_id, kind, title, body, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.projectId, i.workspaceId, i.kind, title, body, path, Date.now());
    this.emit('changed', i.projectId);
    return this.artifact(id)!;
  }

  artifacts(projectId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId) as ArtifactRow[]).map(toArtifact);
  }

  artifact(id: string): Artifact | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return r && toArtifact(r);
  }
}
