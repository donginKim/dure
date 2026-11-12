import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Note, NoteSummary } from '@shared/types';

interface Row { id: string; title: string; body: string; created_at: number; updated_at: number }
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 200_000;
const MAX_NOTES = 5000;
const PREVIEW = 120;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const toNote = (r: Row): Note => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at });

/** 찾은 낱말의 앞뒤를 잘라 보여 준다. 찾지 않았거나 제목에서만 찾았으면 본문의 앞부분. */
function preview(body: string, query: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return flat.slice(0, PREVIEW);
  const from = Math.max(0, at - 30);
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + PREVIEW)}`;
}

/**
 * 메모장. 프로젝트와 상관없이 하나다: 어디서든 열어 적고, 낱말로 찾는다.
 * 이벤트: 'changed'
 */
export class NoteStore extends EventEmitter {
  constructor(private readonly db: Database.Database) { super(); }

  /** 고친 순서대로 (새 것부터). query 가 있으면 제목이나 본문에 그 낱말이 모두 든 것만. */
  list(query = '', limit = 200): NoteSummary[] {
    const words = oneLine(query, 200).split(' ').filter(Boolean).slice(0, 8);
    // LIKE 의 %, _ 는 글자 그대로 찾는다.
    const esc = (w: string): string => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = words.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(' AND ');
    const rows = this.db.prepare(`SELECT * FROM notes ${where ? `WHERE ${where}` : ''} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...words.flatMap((w) => [esc(w), esc(w)]), Math.min(500, Math.max(1, limit))) as Row[];
    return rows.map((r) => ({ id: r.id, title: r.title, preview: preview(r.body, words[0] ?? ''), updatedAt: r.updated_at }));
  }

  get(id: string): Note | undefined {
    const r = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(String(id)) as Row | undefined;
    return r && toNote(r);
  }

  create(i: { title?: string; body?: string } = {}): Note {
    const n = (this.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n;
    if (n >= MAX_NOTES) throw new Error(`메모는 ${MAX_NOTES}개까지 둘 수 있습니다. 쓰지 않는 메모를 지우세요.`);
    const body = String(i.body ?? '');
    if (body.length > MAX_NOTE_BODY) throw new Error(`메모가 너무 깁니다 (${MAX_NOTE_BODY.toLocaleString()}자까지).`);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO notes (id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, oneLine(i.title, MAX_NOTE_TITLE), body, now, now);
    this.emit('changed');
    return this.get(id)!;
  }

  update(id: string, patch: { title?: string; body?: string }): Note {
    const old = this.get(id);
    if (!old) throw new Error('메모가 없습니다 (지워졌을 수 있습니다).');
    const title = patch.title === undefined ? old.title : oneLine(patch.title, MAX_NOTE_TITLE);
    const body = patch.body === undefined ? old.body : String(patch.body);
    if (body.length > MAX_NOTE_BODY) throw new Error(`메모가 너무 깁니다 (${MAX_NOTE_BODY.toLocaleString()}자까지).`);
    if (title === old.title && body === old.body) return old;
    this.db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(title, body, Date.now(), old.id);
    this.emit('changed');
    return this.get(old.id)!;
  }

  remove(id: string): void {
    if (this.db.prepare('DELETE FROM notes WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }
}
