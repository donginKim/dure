import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { MemoryItem, MemoryKind } from '@shared/types';

const KINDS: MemoryKind[] = ['decision', 'lesson', 'command'];
const LABEL: Record<MemoryKind, string> = { decision: '정한 것', lesson: '배운 것', command: '명령' };
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

/**
 * 프로젝트 기억: 대화가 끊겨도 남아야 하는 짧은 사실들 (정한 것, 실패한 접근에서 배운 것, 자주 쓰는 명령).
 * 에이전트와 사용자가 한 줄씩 적는다. 새 대화를 시작할 때 두레가 간추려 건넨다 (TODO 마다 새 대화를 써도 품질이 떨어지지 않게).
 * 이벤트: 'changed'
 */
export class MemoryStore extends EventEmitter {
  constructor(private readonly db: Database.Database) { super(); }

  list(projectId: string): MemoryItem[] {
    return (this.db.prepare('SELECT * FROM project_memory WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as { id: string; project_id: string; kind: string; text: string; author: string; created_at: number }[])
      .map((r) => ({ id: r.id, projectId: r.project_id, kind: (KINDS.includes(r.kind as MemoryKind) ? r.kind : 'lesson') as MemoryKind, text: r.text, author: r.author, createdAt: r.created_at }));
  }

  add(projectId: string, i: { kind?: unknown; text: unknown; author: string }): MemoryItem {
    const text = oneLine(i.text, 300);
    if (!text) throw new Error('적을 내용이 없습니다.');
    const kind = (KINDS.includes(i.kind as MemoryKind) ? i.kind : 'lesson') as MemoryKind;
    // 같은 글은 다시 적지 않는다.
    const same = this.db.prepare('SELECT id FROM project_memory WHERE project_id = ? AND text = ?').get(projectId, text) as { id: string } | undefined;
    if (same) return this.list(projectId).find((m) => m.id === same.id)!;
    const item: MemoryItem = { id: crypto.randomUUID(), projectId, kind, text, author: oneLine(i.author, 40) || '에이전트', createdAt: Date.now() };
    this.db.prepare('INSERT INTO project_memory (id, project_id, kind, text, author, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, projectId, kind, text, item.author, item.createdAt);
    // 끝없이 쌓이지 않게: 프로젝트마다 200개까지 (오래된 것부터 버린다).
    this.db.prepare('DELETE FROM project_memory WHERE project_id = ? AND id NOT IN (SELECT id FROM project_memory WHERE project_id = ? ORDER BY created_at DESC LIMIT 200)').run(projectId, projectId);
    this.emit('changed');
    return item;
  }

  remove(id: string): void {
    if (this.db.prepare('DELETE FROM project_memory WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }

  /** 새 대화에 건넬 간추림 (새것부터, 글자 수 상한까지). 없으면 빈 글. */
  digest(projectId: string, maxChars = 1500): string {
    const lines: string[] = [];
    let n = 0;
    for (const m of this.list(projectId)) {
      const line = `- [${LABEL[m.kind]}] ${m.text}`;
      if (n + line.length > maxChars) break;
      lines.push(line); n += line.length + 1;
    }
    return lines.join('\n');
  }
}
