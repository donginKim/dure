import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Pin, PinInput, PinKind } from '@shared/types';
import type { WorkspaceStore } from './stores';

interface Row { id: string; workspace_id: string; item_id: string; kind: string; source: string; title: string; body: string; created_at: number }
export const MAX_PINS = 200;
export const MAX_PIN_BODY = 50_000;
const MAX_TITLE = 60;
const MAX_SOURCE = 80;
const MAX_ITEM_ID = 200;
const KINDS: readonly PinKind[] = ['user', 'assistant', 'dure', 'output', 'peer'];
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const toPin = (r: Row): Pin => ({ id: r.id, workspaceId: r.workspace_id, itemId: r.item_id, kind: r.kind as PinKind, source: r.source, title: r.title, body: r.body, createdAt: r.created_at });
/** 목록에 보일 제목: 글이 든 첫 줄. 마크다운 기호(#, -, >, **, `)는 떼어 글자만 남긴다. */
const titleOf = (body: string): string => {
  const line = body.split('\n').find((l) => l.replace(/[#>\-*`_\s|]/g, '')) ?? '';
  return oneLine(line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/\*\*|__|`/g, ''), MAX_TITLE);
};

/**
 * 대화의 글에 꽂은 핀. 글의 id 와 함께 내용을 담아 둔다:
 * 대화가 새로 시작되거나 줄어 그 글이 화면에서 사라져도 핀으로 내용을 볼 수 있다.
 * 사용자만 쓴다 (에이전트와 함께하는 사람에게는 내주지 않는다).
 * 이벤트: 'changed'
 */
export class PinStore extends EventEmitter {
  constructor(private readonly db: Database.Database, private readonly workspaces: WorkspaceStore) { super(); }

  /** 그 워크스페이스의 핀. 새로 꽂은 것부터. */
  list(workspaceId: string): Pin[] {
    return (this.db.prepare('SELECT * FROM pins WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC').all(String(workspaceId)) as Row[]).map(toPin);
  }

  /** 글에 핀을 꽂는다. 이미 꽂힌 글이면 있던 핀을 그대로 돌려준다. */
  add(i: PinInput): Pin {
    const workspaceId = String(i?.workspaceId ?? '');
    if (!this.workspaces.get(workspaceId)) throw new Error('워크스페이스가 없습니다 (지워졌을 수 있습니다).');
    const itemId = String(i.itemId ?? '');
    if (!itemId || itemId.length > MAX_ITEM_ID) throw new Error('핀을 꽂을 글을 알 수 없습니다.');
    if (!KINDS.includes(i.kind)) throw new Error('이 글에는 핀을 꽂을 수 없습니다.');
    const old = this.db.prepare('SELECT * FROM pins WHERE workspace_id = ? AND item_id = ?').get(workspaceId, itemId) as Row | undefined;
    if (old) return toPin(old);
    const body = String(i.body ?? '').slice(0, MAX_PIN_BODY);
    if (!body.trim()) throw new Error('빈 글에는 핀을 꽂을 수 없습니다.');
    const n = (this.db.prepare('SELECT count(*) AS n FROM pins WHERE workspace_id = ?').get(workspaceId) as { n: number }).n;
    if (n >= MAX_PINS) throw new Error(`핀은 워크스페이스마다 ${MAX_PINS}개까지 꽂을 수 있습니다. 쓰지 않는 핀을 빼세요.`);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO pins (id, workspace_id, item_id, kind, source, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, itemId, i.kind, oneLine(i.source, MAX_SOURCE), titleOf(body), body, Date.now());
    this.emit('changed');
    return toPin(this.db.prepare('SELECT * FROM pins WHERE id = ?').get(id) as Row);
  }

  remove(id: string): void {
    if (this.db.prepare('DELETE FROM pins WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }
}
