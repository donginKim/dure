import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Figure, FigureKind } from '@shared/types';

const MAX_SVG = 600_000;
const MAX_MERMAID = 60_000;
const KEEP = 100;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

interface Row { id: string; project_id: string; workspace_id: string; group_id: string; version: number; title: string; kind: string; source: string; note: string; created_at: number }
const toFigure = (r: Row): Figure => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, groupId: r.group_id, version: r.version, title: r.title,
  kind: r.kind === 'mermaid' ? 'mermaid' : 'svg', source: r.source, note: r.note, createdAt: r.created_at,
});

/**
 * 에이전트가 그린 그림 (SVG, Mermaid). 워크스페이스의 오른쪽 패널 "그림" 탭에 보인다.
 * - 고치면 같은 그림의 새 판으로 쌓인다 (groupId 가 같고 version 이 오른다).
 * - 화면은 그림을 이미지로만 띄운다 (스크립트가 돌지 않고, 바깥 주소를 불러오지 않는다). 여기서는 모양과 크기만 본다.
 * 이벤트: 'changed' (workspaceId, figure?)
 */
export class FigureService extends EventEmitter {
  constructor(private readonly db: Database.Database) { super(); }

  list(workspaceId: string): Figure[] {
    return (this.db.prepare('SELECT * FROM figures WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, KEEP) as Row[]).map(toFigure);
  }

  get(id: string): Figure | undefined {
    const r = this.db.prepare('SELECT * FROM figures WHERE id = ?').get(id) as Row | undefined;
    return r && toFigure(r);
  }

  /** 그림을 올린다. replaces: 고치는 그림의 id (같은 워크스페이스의 것). 없으면 새 그림. */
  show(projectId: string, workspaceId: string, i: { title?: unknown; kind: FigureKind; source: unknown; note?: unknown; replaces?: unknown }): Figure {
    const title = oneLine(i.title, 120) || '그림';
    const kind: FigureKind = i.kind === 'mermaid' ? 'mermaid' : 'svg';
    let source = String(i.source ?? '').trim();
    if (!source) throw new Error('그림이 비어 있다.');
    if (kind === 'svg') {
      if (source.length > MAX_SVG) throw new Error(`SVG 가 너무 크다 (${MAX_SVG}자까지). 단순하게 다시 그려라.`);
      // 앞의 XML 선언과 주석은 괜찮다. 본체는 <svg> 여야 한다.
      const body = source.replace(/^<\?xml[^>]*\?>\s*/i, '').replace(/^<!--[\s\S]*?-->\s*/g, '').replace(/^<!DOCTYPE[^>]*>\s*/i, '');
      if (!/^<svg[\s>]/i.test(body) || !/<\/svg>\s*$/i.test(body)) throw new Error('SVG 는 <svg ...> 로 시작해 </svg> 로 끝나야 한다.');
      // 이름공간이 없으면 이미지로 띄울 때 그려지지 않는다.
      if (!/<svg[^>]*\sxmlns=/i.test(body)) source = body.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      else source = body;
    } else if (source.length > MAX_MERMAID) throw new Error(`Mermaid 가 너무 길다 (${MAX_MERMAID}자까지).`);
    let groupId: string = crypto.randomUUID();
    let version = 1;
    if (typeof i.replaces === 'string' && i.replaces) {
      const before = this.get(i.replaces);
      if (!before || before.workspaceId !== workspaceId) throw new Error('고치려는 그림이 없다. figure_list 의 id 를 적어라.');
      groupId = before.groupId;
      version = (this.db.prepare('SELECT max(version) AS v FROM figures WHERE group_id = ?').get(groupId) as { v: number }).v + 1;
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO figures (id, project_id, workspace_id, group_id, version, title, kind, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, workspaceId, groupId, version, title, kind, source, oneLine(i.note, 300), Date.now());
    // 오래된 것은 지운다.
    this.db.prepare('DELETE FROM figures WHERE workspace_id = ? AND id NOT IN (SELECT id FROM figures WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?)').run(workspaceId, workspaceId, KEEP);
    const f = this.get(id)!;
    this.emit('changed', workspaceId, f);
    return f;
  }

  remove(id: string): void {
    const f = this.get(id);
    if (!f) return;
    this.db.prepare('DELETE FROM figures WHERE id = ?').run(id);
    this.emit('changed', f.workspaceId);
  }
}
