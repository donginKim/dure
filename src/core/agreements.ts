import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Agreement, AgreementKind } from '@shared/types';

const KINDS: AgreementKind[] = ['api', 'naming', 'decision', 'other'];
const MAX = 200;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
// eslint-disable-next-line no-control-regex
const text = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max);

interface Row { id: string; project_id: string; kind: string; title: string; body: string; status: string; author: string; replaces: string | null; updated_at: number }
const toAgreement = (r: Row): Agreement => ({
  id: r.id, projectId: r.project_id, kind: KINDS.includes(r.kind as AgreementKind) ? r.kind as AgreementKind : 'other', title: r.title, body: r.body,
  status: r.status === 'proposed' ? 'proposed' : 'active', author: r.author, replaces: r.replaces, updatedAt: r.updated_at,
});

/**
 * 프로젝트의 약속: API 형식, 이름 규칙, 정한 것. 모든 에이전트가 읽고 따른다.
 * - 사용자는 바로 적고 고치고 지운다.
 * - 에이전트는 제안만 한다 (proposed). 사용자가 받아들여야 약속이 된다. 받아들이면 그 프로젝트의 모든 에이전트에게 알린다.
 * 이벤트: 'changed' (projectId), 'settled' (agreement, previous?: 바뀐 약속 — 에이전트들에게 알리는 데 쓴다)
 */
export class AgreementService extends EventEmitter {
  constructor(private readonly db: Database.Database) { super(); }

  list(projectId: string, o: { proposed?: boolean } = {}): Agreement[] {
    const rows = this.db.prepare(`SELECT * FROM agreements WHERE project_id = ? ${o.proposed ? '' : "AND status = 'active'"} ORDER BY status, kind, updated_at`).all(projectId) as Row[];
    return rows.map(toAgreement);
  }

  get(id: string): Agreement | undefined {
    const r = this.db.prepare('SELECT * FROM agreements WHERE id = ?').get(id) as Row | undefined;
    return r && toAgreement(r);
  }

  private clean(i: { kind?: unknown; title?: unknown; body?: unknown }): { kind: AgreementKind; title: string; body: string } {
    const title = oneLine(i.title, 120);
    if (!title) throw new Error('약속의 제목을 적으세요.');
    const body = text(i.body, 8000);
    if (!body) throw new Error('약속의 내용을 적으세요.');
    return { kind: KINDS.includes(i.kind as AgreementKind) ? i.kind as AgreementKind : 'other', title, body };
  }

  /** 사용자가 약속을 적는다 (바로 약속이 된다). id 를 주면 그 약속을 고친다. */
  save(projectId: string, i: { id?: string; kind?: unknown; title?: unknown; body?: unknown }): Agreement {
    const c = this.clean(i);
    const before = i.id ? this.get(i.id) : undefined;
    if (i.id && (!before || before.projectId !== projectId)) throw new Error('그런 약속이 없습니다.');
    if (!before && this.list(projectId, { proposed: true }).length >= MAX) throw new Error(`약속은 ${MAX}개까지입니다.`);
    const id = before?.id ?? crypto.randomUUID();
    this.db.prepare('INSERT INTO agreements (id, project_id, kind, title, body, status, author, replaces, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body, status = excluded.status, updated_at = excluded.updated_at')
      .run(id, projectId, c.kind, c.title, c.body, 'active', before?.author ?? '사용자', Date.now());
    const a = this.get(id)!;
    this.emit('changed', projectId);
    this.emit('settled', a, before?.status === 'active' ? before : undefined);
    return a;
  }

  /** 에이전트가 약속을 제안한다. replaces: 바꾸자고 하는 약속의 id. 사용자가 받아들여야 약속이 된다. */
  propose(projectId: string, author: string, i: { kind?: unknown; title?: unknown; body?: unknown; replaces?: unknown }): Agreement {
    const c = this.clean(i);
    const replaces = typeof i.replaces === 'string' && i.replaces ? i.replaces : null;
    if (replaces) { const r = this.get(replaces); if (!r || r.projectId !== projectId || r.status !== 'active') throw new Error('바꾸려는 약속이 없다. agreements_list 의 id 를 적어라.'); }
    const waiting = this.list(projectId, { proposed: true }).filter((a) => a.status === 'proposed');
    if (waiting.length >= 20) throw new Error('사용자가 아직 보지 않은 제안이 많다. 사용자가 정한 뒤에 다시 제안하라.');
    if (this.list(projectId, { proposed: true }).length >= MAX) throw new Error(`약속은 ${MAX}개까지다.`);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO agreements (id, project_id, kind, title, body, status, author, replaces, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, c.kind, c.title, c.body, 'proposed', oneLine(author, 60) || '에이전트', replaces, Date.now());
    this.emit('changed', projectId);
    return this.get(id)!;
  }

  /** 사용자가 제안을 받아들인다. 바꾸자는 제안이면 앞의 약속을 이것으로 바꾼다. */
  accept(id: string): Agreement {
    const a = this.get(id);
    if (!a || a.status !== 'proposed') throw new Error('기다리는 제안이 아닙니다.');
    const before = a.replaces ? this.get(a.replaces) : undefined;
    this.db.transaction(() => {
      if (before) {
        this.db.prepare("UPDATE agreements SET kind = ?, title = ?, body = ?, author = ?, updated_at = ? WHERE id = ?").run(a.kind, a.title, a.body, a.author, Date.now(), before.id);
        this.db.prepare('DELETE FROM agreements WHERE id = ?').run(a.id);
      } else {
        this.db.prepare("UPDATE agreements SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), a.id);
      }
    })();
    const now = this.get(before?.id ?? a.id)!;
    this.emit('changed', a.projectId);
    this.emit('settled', now, before);
    return now;
  }

  remove(id: string): void {
    const a = this.get(id);
    if (!a) return;
    this.db.prepare('DELETE FROM agreements WHERE id = ?').run(id);
    // 그 약속을 바꾸자던 제안은 갈 곳이 없다.
    this.db.prepare("DELETE FROM agreements WHERE replaces = ? AND status = 'proposed'").run(id);
    this.emit('changed', a.projectId);
  }
}
