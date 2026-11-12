import { EventEmitter } from 'node:events';
import type { AttentionItem } from '@shared/types';

// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

/** 여기서 쓰는 만큼만 적은 다른 서비스들의 모양 */
export interface AttentionSources {
  projects(): { id: string; name: string }[];
  isClosed(projectId: string): boolean;
  workspaces(projectId: string): { id: string; name: string; role?: string; status: string }[];
  plan(projectId: string): { id: string; items: unknown[]; projectTodos: unknown[] } | null;
  db(projectId: string): { id: string; workspaceId: string; connectionName: string }[];
  slack(projectId: string): { id: string; workspaceId: string; what: string }[];
  browser(projectId: string): { id: string; workspaceId: string; origin: string }[];
  held(projectId: string): { id: string; toWorkspaceId: string; toPerson: boolean; fromLabel: string; body: string }[];
  assignments(projectId: string): { id: string; fromName: string; state: string; items: unknown[] }[];
  briefs(projectId: string): { id: string; fromName: string }[];
  pairs(): { id: string; name: string; direction: string; confirmed: boolean }[];
  invites(): { id: string; name: string; fromName: string }[];
}

/**
 * 확인할 것: 에이전트나 다른 사람이 사용자를 기다리는 것을 한데 모은다.
 * 흩어져 있는 요청(계획안, 권한, DB·슬랙·브라우저 승인, 받은 메시지와 배정, 연결 요청과 초대)을 한 목록으로 만든다.
 * 이벤트: 'changed' — 목록이 바뀜. 'added' (items) — 새로 생긴 것 (알림을 띄울 때 쓴다)
 */
export class AttentionService extends EventEmitter {
  private known = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(private readonly s: AttentionSources) { super(); }

  list(): AttentionItem[] {
    const out: AttentionItem[] = [];
    const safe = <T>(fn: () => T[]): T[] => { try { return fn(); } catch { return []; } };
    for (const p of safe(() => this.s.projects())) {
      if (this.s.isClosed(p.id)) continue;
      const ws = safe(() => this.s.workspaces(p.id));
      const name = (id: string): string => { const w = ws.find((x) => x.id === id); return !w ? '에이전트' : w.role === 'coordinator' ? '조율 에이전트' : `"${w.name}" 에이전트`; };
      const add = (kind: AttentionItem['kind'], id: string, workspaceId: string | null, title: string, detail = ''): void => {
        out.push({ id: `${kind}:${id}`, kind, projectId: p.id, projectName: p.name, workspaceId, title: oneLine(title, 160), detail: oneLine(detail, 200) });
      };
      let plan: ReturnType<AttentionSources['plan']> = null;
      try { plan = this.s.plan(p.id); } catch { /* 계획안 없음 */ }
      if (plan) add('plan', plan.id, ws.find((w) => w.role === 'coordinator')?.id ?? null, '계획안이 승인을 기다립니다', `워크스페이스 ${plan.items.length}개, 프로젝트 TODO ${plan.projectTodos.length}개`);
      for (const w of ws) if (w.status === 'waiting_user') add('agent', w.id, w.id, `${name(w.id)}가 답을 기다립니다`, '권한을 묻거나 질문을 했습니다');
      for (const r of safe(() => this.s.db(p.id))) add('db', r.id, r.workspaceId, `${name(r.workspaceId)}가 DB 를 조회하려 합니다`, r.connectionName);
      for (const r of safe(() => this.s.slack(p.id))) add('slack', r.id, r.workspaceId, `${name(r.workspaceId)}가 슬랙을 읽으려 합니다`, r.what);
      for (const r of safe(() => this.s.browser(p.id))) add('browser', r.id, r.workspaceId, `${name(r.workspaceId)}가 브라우저로 주소를 열려 합니다`, r.origin);
      for (const h of safe(() => this.s.held(p.id))) add('held', h.id, h.toPerson ? null : h.toWorkspaceId, h.toPerson ? `"${h.fromLabel}" 이(가) 나에게 물었습니다` : `"${h.fromLabel}" 의 메시지가 넘겨주기를 기다립니다`, h.body);
      for (const b of safe(() => this.s.briefs(p.id))) add('brief', b.id, null, `"${b.fromName}" 이(가) 기획서 정리를 보냈습니다`, '읽고 자료로 받거나 버리세요');
      for (const a of safe(() => this.s.assignments(p.id))) if (a.state === 'pending') add('assign', a.id, null, `"${a.fromName}" 이(가) 일을 나눠 주었습니다`, `워크스페이스 ${a.items.length}개`);
    }
    for (const r of safe(() => this.s.pairs())) if (r.direction === 'in' && !r.confirmed) out.push({ id: `pair:${r.id}`, kind: 'pair', projectId: null, projectName: '', workspaceId: null, title: oneLine(`"${r.name}" 이(가) 연결을 요청합니다`, 160), detail: '숫자가 같은지 확인하고 연결하세요' });
    for (const i of safe(() => this.s.invites())) out.push({ id: `invite:${i.id}`, kind: 'invite', projectId: null, projectName: '', workspaceId: null, title: oneLine(`"${i.fromName}" 이(가) 프로젝트 "${i.name}" 에 초대했습니다`, 160), detail: '' });
    return out;
  }

  /** 다른 서비스가 바뀌었다고 알릴 때 부른다. 잠깐 모아서 한 번만 다시 본다. */
  poke(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
    this.timer.unref?.();
  }

  /** 목록을 다시 보고, 새로 생긴 것을 알린다. 처음 한 번은 알리지 않는다 (켤 때 이미 있던 것). */
  refresh(): void {
    const items = this.list();
    const fresh = items.filter((i) => !this.known.has(i.id));
    const before = this.known.size;
    this.known = new Set(items.map((i) => i.id));
    if (this.started && fresh.length) this.emit('added', fresh);
    if (!this.started || fresh.length || before !== this.known.size) this.emit('changed');
    this.started = true;
  }

  dispose(): void { clearTimeout(this.timer); }
}
