import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { CommitDraft } from '@shared/types';

interface Row { workspace_id: string; message: string; updated_at: number }

/**
 * 에이전트가 써 둔 커밋 메시지 초안. 워크스페이스마다 하나다.
 * 사용자가 커밋 창에서 이 글을 고쳐 커밋한다.
 * 이벤트: 'changed' (workspaceId)
 */
export class CommitDraftStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  save(workspaceId: string, message: string): CommitDraft {
    const text = message.trim();
    if (!text) throw new Error('커밋 메시지를 입력하세요.');
    this.db.prepare(
      `INSERT INTO commit_drafts (workspace_id, message, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at`,
    ).run(workspaceId, text, Date.now());
    this.emit('changed', workspaceId);
    return this.get(workspaceId)!;
  }

  get(workspaceId: string): CommitDraft | undefined {
    const r = this.db.prepare('SELECT * FROM commit_drafts WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
    return r && { workspaceId: r.workspace_id, message: r.message, updatedAt: r.updated_at };
  }

  clear(workspaceId: string): void {
    const res = this.db.prepare('DELETE FROM commit_drafts WHERE workspace_id = ?').run(workspaceId);
    if (res.changes > 0) this.emit('changed', workspaceId);
  }
}
