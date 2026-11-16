import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Capture } from '@shared/types';

/**
 * 빠른 메모: 어느 앱에서든 단축키로 한 줄 적어 두는 받은함. 나중에 프로젝트의 TODO 로 보내거나 지운다.
 * 이벤트: 'changed'
 */
export class CaptureStore extends EventEmitter {
  constructor(private readonly d: {
    db: Database.Database;
    addTodo(projectId: string, workspaceId: string | null, title: string, detail: string): void;
  }) { super(); }

  list(): Capture[] {
    return (this.d.db.prepare('SELECT id, text, created_at FROM captures ORDER BY created_at DESC LIMIT 200').all() as { id: string; text: string; created_at: number }[])
      .map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
  }

  add(text: unknown): Capture {
    // eslint-disable-next-line no-control-regex
    const t = String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 4000);
    if (!t) throw new Error('적을 글이 없습니다.');
    const c: Capture = { id: crypto.randomUUID(), text: t, createdAt: Date.now() };
    this.d.db.prepare('INSERT INTO captures (id, text, created_at) VALUES (?, ?, ?)').run(c.id, c.text, c.createdAt);
    this.emit('changed');
    return c;
  }

  remove(id: string): void {
    if (this.d.db.prepare('DELETE FROM captures WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }

  /** 메모를 TODO 로 보낸다 (첫 줄이 제목, 나머지가 설명). 보낸 메모는 지운다. */
  toTodo(id: string, projectId: string, workspaceId: string | null): void {
    const r = this.d.db.prepare('SELECT text FROM captures WHERE id = ?').get(String(id)) as { text: string } | undefined;
    if (!r) throw new Error('메모가 없습니다.');
    const [first, ...rest] = r.text.split('\n');
    this.d.addTodo(String(projectId), workspaceId ? String(workspaceId) : null, (first ?? '').trim().slice(0, 200) || '메모', rest.join('\n').trim());
    this.remove(id);
  }
}
