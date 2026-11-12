import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Checkpoint, CheckpointKind, CheckpointPreview } from '@shared/types';
import type { Git } from './git';
import type { WorkspaceStore } from './stores';

interface Row { id: string; workspace_id: string; label: string; kind: string; commit_sha: string; base_sha: string; tree_sha: string; created_at: number }
const KEEP = 30;
const MAX_FILES = 30;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const toCheckpoint = (r: Row): Checkpoint => ({ id: r.id, workspaceId: r.workspace_id, label: r.label, kind: r.kind === 'manual' ? 'manual' : r.kind === 'safety' ? 'safety' : 'auto', createdAt: r.created_at });
const ref = (id: string): string => `refs/dure/checkpoints/${id}`;

/**
 * 되돌리기 지점. 워크스페이스의 작업 폴더를 그때의 모습 그대로 적어 두고 (커밋하지 않은 것과 새 파일 포함), 나중에 그 모습으로 되돌린다.
 * - 적어 두는 것은 작업 폴더도 스테이징 상태도 건드리지 않는다. git 객체로만 남기고 브랜치에는 붙이지 않는다.
 * - 에이전트에게 일을 시키기 직전에 저절로 하나 만든다. 그 뒤로 바뀐 것이 없으면 새로 만들지 않는다.
 * - 되돌리기 직전의 모습도 하나 적어 둔다: 되돌린 것을 다시 무를 수 있다.
 * 이벤트: 'changed' (workspaceId)
 */
export class CheckpointService extends EventEmitter {
  private readonly busy = new Set<string>();

  constructor(private readonly d: { db: Database.Database; workspaces: WorkspaceStore; git: Git }) { super(); }

  private dir(workspaceId: string): string {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || ws.role === 'coordinator' || !ws.worktreePath) throw new Error('되돌리기 지점을 둘 수 있는 워크스페이스가 아닙니다.');
    if (!existsSync(ws.worktreePath)) throw new Error('작업 폴더를 찾을 수 없습니다.');
    return ws.worktreePath;
  }

  list(workspaceId: string): Checkpoint[] {
    return (this.d.db.prepare('SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC').all(workspaceId) as Row[]).map(toCheckpoint);
  }

  /** 지금의 모습을 적어 둔다. 바로 앞의 지점과 같으면 새로 만들지 않고 그것을 돌려준다. */
  async create(workspaceId: string, label: string, kind: CheckpointKind = 'manual'): Promise<Checkpoint> {
    const path = this.dir(workspaceId);
    const git = (args: string[]): Promise<string> => this.d.git.raw(['-C', path, ...args]);
    const base = (await git(['rev-parse', 'HEAD'])).trim();
    const tree = await this.d.git.snapshotTree(path);
    const last = this.d.db.prepare('SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(workspaceId) as Row | undefined;
    if (last && last.tree_sha === tree && last.base_sha === base && kind !== 'manual') return toCheckpoint(last);
    const id = crypto.randomUUID();
    const commit = await this.d.git.commitTree(path, tree, base, `dure checkpoint ${id}`);
    // 이름을 붙여 둔다: 이름이 없으면 git 이 정리하면서 지울 수 있다.
    await git(['update-ref', ref(id), commit]);
    this.d.db.prepare('INSERT INTO checkpoints (id, workspace_id, label, kind, commit_sha, base_sha, tree_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, oneLine(label, 80), kind, commit, base, tree, Date.now());
    // 오래된 것은 지운다.
    const old = this.d.db.prepare('SELECT id FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(workspaceId, KEEP) as { id: string }[];
    for (const o of old) {
      this.d.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(o.id);
      await git(['update-ref', '-d', ref(o.id)]).catch(() => undefined);
    }
    this.emit('changed', workspaceId);
    return toCheckpoint(this.d.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row);
  }

  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(String(id)) as Row | undefined;
    if (!r) throw new Error('되돌리기 지점이 없습니다 (오래돼 지워졌을 수 있습니다).');
    return r;
  }

  /** 그 지점으로 되돌리면 바뀔 파일과, 함께 되돌려질 커밋의 수. */
  async preview(id: string): Promise<CheckpointPreview> {
    const r = this.row(id);
    const path = this.dir(r.workspace_id);
    const git = (args: string[]): Promise<string> => this.d.git.raw(['-C', path, ...args]);
    const now = await this.d.git.snapshotTree(path);
    const files = (await git(['diff', '--name-only', '--no-renames', r.tree_sha, now])).split('\n').filter(Boolean);
    const commits = Number((await git(['rev-list', '--count', `${r.base_sha}..HEAD`]).catch(() => '0')).trim()) || 0;
    return { files: files.slice(0, MAX_FILES), moreFiles: Math.max(0, files.length - MAX_FILES), commits };
  }

  /**
   * 작업 폴더를 그 지점의 모습으로 되돌린다: 파일, 새로 생긴 파일(지운다), 그 뒤에 한 커밋(브랜치를 그때로 돌린다).
   * git 이 무시하는 파일(.env, node_modules 등)은 건드리지 않는다. 되돌리기 직전의 모습을 먼저 적어 둔다.
   */
  async restore(id: string): Promise<Checkpoint> {
    const r = this.row(id);
    const ws = this.d.workspaces.get(r.workspace_id);
    const path = this.dir(r.workspace_id);
    if (ws && (ws.status === 'working' || ws.status === 'starting')) throw new Error('에이전트가 일하는 중입니다. 멈춘 뒤에 되돌리세요.');
    if (await this.d.git.merging(path)) throw new Error('병합이 진행 중입니다. 끝내거나 취소한 뒤에 되돌리세요.');
    if (this.busy.has(r.workspace_id)) throw new Error('이미 되돌리는 중입니다.');
    this.busy.add(r.workspace_id);
    try {
      const git = (args: string[]): Promise<string> => this.d.git.raw(['-C', path, ...args]);
      const safety = await this.create(r.workspace_id, '되돌리기 전의 모습', 'safety');
      // 파일을 그때의 모습으로 (그때 없던 추적 파일은 지운다).
      await git(['read-tree', '--reset', '-u', r.commit_sha]);
      // 그 뒤에 새로 생긴 파일을 지운다. 그때 있던 파일은 지금 인덱스에 있어 남는다. 무시하는 파일은 건드리지 않는다.
      await git(['clean', '-fd', '-q']);
      // 브랜치를 그때의 커밋으로 돌리고, 그때 커밋하지 않았던 것은 다시 "바뀐 파일" 로 둔다.
      await git(['reset', '-q', '--soft', r.base_sha]);
      await git(['reset', '-q']);
      this.emit('changed', r.workspace_id);
      return safety;
    } finally {
      this.busy.delete(r.workspace_id);
    }
  }
}
