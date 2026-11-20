import type Database from 'better-sqlite3';
import type { Project, StewardBoard, StewardBoardProject, Workspace } from '@shared/types';

const DAY = 86_400_000;
const MAX_DAYS = 92;
const two = (n: number): string => String(n).padStart(2, '0');
/** 이 PC 의 시각으로 그날 (YYYY-MM-DD) */
export const localDay = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const startOf = (day: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new Error(`날짜는 YYYY-MM-DD 로 적습니다: ${day}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2월 31일 같은 없는 날짜는 다른 날로 넘어간다: 받지 않는다.
  if (Number.isNaN(d.getTime()) || localDay(d.getTime()) !== m[0]) throw new Error(`없는 날짜입니다: ${day}`);
  return d.getTime();
};
const short = (day: string): string => { const [, m, d] = day.split('-').map(Number); return `${m}/${d}`; };
const hours = (ms: number): string => { const min = Math.round(ms / 60_000); const h = Math.floor(min / 60); return h && min % 60 ? `${h}시간 ${min % 60}분` : h ? `${h}시간` : `${min}분`; };

/** 이번 주 (월요일부터 일요일까지). offset: -1 이면 지난 주 */
export function weekRange(now = Date.now(), offset = 0): { from: string; to: string } {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  const end = new Date(d); end.setDate(end.getDate() + 6);
  return { from: localDay(d.getTime()), to: localDay(end.getTime()) };
}

export interface StewardBoardDeps {
  db: Database.Database;
  /** 사용자의 프로젝트 (완료 처리한 것 포함. 비서의 프로젝트는 빼고) */
  projects(): Project[];
  workspaces: { get(id: string): Workspace | undefined; listAll(projectId: string): Workspace[] };
  /** 그 달의 근무 기록 (기록이 있는 날만. month 는 1~12) */
  workMonth(year: number, month: number): { day: string; totalMs: number }[];
  attention(): { title: string; projectName: string; projectId: string | null }[];
  /** 그 워크스페이스의 저장소에서 커밋의 제목을 읽는다. 못 읽으면 null */
  commitSubject(workspace: Workspace, hash: string): Promise<string | null>;
  now?: () => number;
}

/**
 * 총괄 현황판: 정한 기간에 모든 프로젝트에서 한 일과 지금의 상태를 모은다.
 * 주간 보고를 이 화면만 보고 쓸 수 있게 하는 것이 목적이다: 무엇을 얼마나 했는지 (근무시간, 끝낸 일, 커밋, 반영),
 * 지금 무엇을 하고 있고 무엇이 남았는지, 무엇이 내 확인을 기다리는지. LLM 을 부르지 않는다.
 */
export class StewardBoardService {
  constructor(private readonly d: StewardBoardDeps) {}
  /** 지금 돌고 있는 채우기 (화면과 비서가 함께 볼 때 같은 커밋을 두 번 읽지 않게) */
  private filling: Promise<void> | undefined;

  /** 두레가 만든 커밋을 적는다 (제목과 그때의 이름). 워크스페이스를 정리한 뒤에도 남는다. */
  noteCommit(workspace: Workspace, hash: string, subject: string, at = Date.now()): void {
    const project = this.d.projects().find((p) => p.id === workspace.projectId);
    // 제목은 에이전트가 쓴 글이다: 한 줄로, 제어 문자 없이 적는다.
    // eslint-disable-next-line no-control-regex
    subject = subject.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
    this.d.db.prepare('INSERT OR REPLACE INTO work_commits (hash, project_id, project_name, workspace_name, subject, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash, workspace.projectId, project?.name ?? '', workspace.role === 'coordinator' ? '조율' : workspace.name, subject.slice(0, 300), at);
  }

  /** 커밋 하나의 제목을 읽어 적는다 (커밋한 직후에 부른다). */
  async recordCommit(workspaceId: string, hash: string, at = Date.now()): Promise<void> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || !/^[0-9a-f]{7,40}$/.test(hash)) return;
    const subject = await this.d.commitSubject(ws, hash).catch(() => null);
    this.noteCommit(ws, hash, subject ?? '', at);
  }

  /**
   * 이 기능이 생기기 전에 만든 커밋 가운데 아직 적지 않은 것을 채운다 (워크스페이스가 남아 있는 것만. 한 번에 200건까지).
   * 제목을 읽지 못한 것도 빈 제목으로 적는다: 볼 때마다 다시 읽지 않는다.
   */
  async backfillCommits(): Promise<void> {
    // 워크스페이스가 남아 있는 것만 뽑는다: 지워진 것은 읽을 곳이 없고, 그런 것이 앞을 채우면 뒤의 것이 영영 채워지지 않는다.
    const rows = this.d.db.prepare('SELECT c.hash, c.workspace_id, c.at FROM dure_commits c JOIN workspaces ws ON ws.id = c.workspace_id WHERE NOT EXISTS (SELECT 1 FROM work_commits w WHERE w.hash = c.hash) ORDER BY c.at DESC LIMIT 200').all() as { hash: string; workspace_id: string; at: number }[];
    for (const r of rows) {
      const ws = this.d.workspaces.get(r.workspace_id);
      if (!ws) continue;
      const subject = await this.d.commitSubject(ws, r.hash).catch(() => null);
      this.noteCommit(ws, r.hash, subject ?? '', r.at);
    }
  }

  async board(range?: { from?: string; to?: string }): Promise<StewardBoard> {
    const now = this.d.now?.() ?? Date.now();
    const week = weekRange(now);
    const from = range?.from || week.from; const to = range?.to || range?.from || week.to;
    const t0 = startOf(from); const tLast = startOf(to);
    if (tLast < t0) throw new Error('끝나는 날이 시작하는 날보다 앞입니다.');
    const count = Math.round((tLast - t0) / DAY) + 1;
    if (count > MAX_DAYS) throw new Error(`기간은 ${MAX_DAYS}일까지 볼 수 있습니다.`);
    const dayList = Array.from({ length: count }, (_, i) => { const d = new Date(t0); d.setDate(d.getDate() + i); return localDay(d.getTime()); });
    const t1 = startOf(dayList[dayList.length - 1]!) + DAY;
    try { await (this.filling ??= this.backfillCommits().finally(() => { this.filling = undefined; })); } catch { /* 제목이 빠질 뿐이다 */ }

    // 근무시간은 달마다 한 번만 읽는다.
    const work = new Map<string, number>();
    for (const ym of new Set(dayList.map((day) => day.slice(0, 7)))) {
      const [y, mo] = ym.split('-').map(Number);
      try { for (const w of this.d.workMonth(y!, mo!)) work.set(w.day, w.totalMs); } catch { /* 근무 기록이 빠질 뿐이다 */ }
    }
    const days = new Map(dayList.map((day) => [day, { day, workMs: work.get(day) ?? 0, done: 0, commits: 0, mains: 0, tokens: 0 }]));
    const known = new Map(this.d.projects().map((p) => [p.id, p]));
    const by = new Map<string, StewardBoardProject>();
    const at = (projectId: string, name = ''): StewardBoardProject => {
      let p = by.get(projectId);
      if (!p) {
        const k = known.get(projectId);
        p = { projectId, name: k?.name ?? (name || '지운 프로젝트'), state: !k ? 'gone' : k.status === 'done' ? 'done' : 'active', done: [], commits: [], commitCount: 0, mains: 0, tokens: 0, doing: [], todo: [], todoCount: 0, progress: { done: 0, total: 0 }, workspaces: [], waiting: [] };
        by.set(projectId, p);
      }
      return p;
    };
    const db = this.d.db;

    for (const r of db.prepare('SELECT project_id, project_name, workspace_name, title, assignee, at FROM work_done WHERE at >= ? AND at < ? ORDER BY at').all(t0, t1) as { project_id: string; project_name: string; workspace_name: string; title: string; assignee: string; at: number }[]) {
      const day = localDay(r.at);
      at(r.project_id, r.project_name).done.push({ title: r.title, workspace: r.workspace_name, at: r.at, day, byUser: r.assignee === 'user' });
      const d = days.get(day); if (d) d.done += 1;
    }
    for (const r of db.prepare('SELECT hash, project_id, project_name, workspace_name, subject, at FROM work_commits WHERE at >= ? AND at < ? ORDER BY at').all(t0, t1) as { hash: string; project_id: string; project_name: string; workspace_name: string; subject: string; at: number }[]) {
      at(r.project_id, r.project_name).commits.push({ hash: r.hash.slice(0, 10), subject: r.subject, workspace: r.workspace_name, at: r.at, day: localDay(r.at) });
    }
    for (const r of db.prepare('SELECT project_id, kind, at FROM work_events WHERE at >= ? AND at < ?').all(t0, t1) as { project_id: string; kind: string; at: number }[]) {
      const d = days.get(localDay(r.at));
      if (r.kind === 'commit') { at(r.project_id).commitCount += 1; if (d) d.commits += 1; } else if (r.kind === 'main') { at(r.project_id).mains += 1; if (d) d.mains += 1; }
    }
    // 적어 둔 커밋이 센 것보다 많으면 (기록이 없던 때의 커밋을 채웠다) 그 수를 쓴다.
    for (const p of by.values()) p.commitCount = Math.max(p.commitCount, p.commits.length);
    // 답 하나에 한 줄씩이라 많다: DB 에서 프로젝트와 날짜로 합쳐 읽는다.
    for (const r of db.prepare("SELECT project_id, date(at / 1000, 'unixepoch', 'localtime') AS day, sum(input + cache_write + output) AS n FROM token_usage WHERE at >= ? AND at < ? GROUP BY project_id, day").all(t0, t1) as { project_id: string; day: string; n: number }[]) {
      if (r.n <= 0) continue;
      const d = days.get(r.day); if (d) d.tokens += r.n;
      // 비서가 쓴 토큰은 합계에만 든다 (프로젝트가 아니다).
      if (known.has(r.project_id) || by.has(r.project_id)) at(r.project_id).tokens += r.n;
    }

    // 지금의 상태: 진행 중인 프로젝트는 기간에 한 일이 없어도 보인다.
    const waiting = this.d.attention();
    for (const p of known.values()) {
      if (p.status === 'done' && !by.has(p.id)) continue;
      const b = at(p.id);
      const wss = this.d.workspaces.listAll(p.id);
      const name = new Map(wss.map((w) => [w.id, w.role === 'coordinator' ? '조율' : w.name]));
      b.workspaces = wss.filter((w) => w.role !== 'coordinator').map((w) => ({ id: w.id, name: w.name, status: w.status, summary: w.summary ?? '' }));
      const todos = db.prepare("SELECT workspace_id, title, status, assignee FROM todos WHERE project_id = ? AND status <> 'cancelled' ORDER BY position").all(p.id) as { workspace_id: string | null; title: string; status: string; assignee: string }[];
      b.progress = { done: todos.filter((t) => t.status === 'done').length, total: todos.length };
      if (p.status === 'done') continue;
      b.doing = todos.filter((t) => t.status === 'doing').map((t) => ({ title: t.title, workspace: t.workspace_id ? name.get(t.workspace_id) ?? '' : '' }));
      const open = todos.filter((t) => t.status === 'todo');
      b.todoCount = open.length;
      b.todo = open.slice(0, 30).map((t) => ({ title: t.title, workspace: t.workspace_id ? name.get(t.workspace_id) ?? '' : '', byUser: t.assignee === 'user' }));
      b.waiting = waiting.filter((a) => a.projectId === p.id).map((a) => a.title);
    }

    // 완료 처리했거나 지운 프로젝트는 이 기간에 한 일이 있을 때만 보인다 (토큰만 쓴 것은 빼고).
    for (const [id, p] of by) { if (p.state !== 'active' && p.done.length === 0 && p.commitCount === 0) by.delete(id); }
    const projects = [...by.values()].sort((a, b) => (b.done.length + b.commitCount) - (a.done.length + a.commitCount) || b.doing.length - a.doing.length || a.name.localeCompare(b.name));
    // 날마다의 커밋 수도 프로젝트와 같은 셈으로: 센 것과 적어 둔 것 가운데 많은 쪽.
    for (const d of days.values()) d.commits = Math.max(d.commits, projects.reduce((n, p) => n + p.commits.filter((c) => c.day === d.day).length, 0));
    const list = [...days.values()];
    const totals = {
      workMs: list.reduce((n, d) => n + d.workMs, 0), workDays: list.filter((d) => d.workMs > 0).length,
      done: projects.reduce((n, p) => n + p.done.length, 0), commits: projects.reduce((n, p) => n + p.commitCount, 0),
      mains: projects.reduce((n, p) => n + p.mains, 0), tokens: list.reduce((n, d) => n + d.tokens, 0),
    };
    const board: StewardBoard = { from: dayList[0]!, to: dayList[dayList.length - 1]!, days: list, totals, projects, waiting: waiting.map((a) => ({ title: a.title, projectName: a.projectName, projectId: a.projectId })), draft: '' };
    board.draft = draft(board);
    return board;
  }
}

/** 주간 보고의 초안. 화면의 숫자와 같은 자료로 만든다: 여기에 없는 것은 적지 않는다. */
export function draft(b: StewardBoard): string {
  const n = b.days.length;
  const title = n === 1 ? `일일 업무 (${short(b.from)})` : `${n <= 7 ? '주간' : n >= 28 && n <= 31 ? '월간' : '기간'} 업무 (${short(b.from)} ~ ${short(b.to)})`;
  const t = b.totals;
  const head = [t.workMs > 0 ? `근무 ${hours(t.workMs)} (${t.workDays}일)` : '', `끝낸 일 ${t.done}건`, `커밋 ${t.commits}건`, t.mains ? `기준 브랜치 반영 ${t.mains}회` : ''].filter(Boolean).join(' · ');
  const out: string[] = [`# ${title}`, '', head, '', '## 한 일'];
  const worked = b.projects.filter((p) => p.done.length || p.commitCount);
  if (worked.length === 0) out.push('- (이 기간에 끝낸 일과 커밋이 없습니다)');
  for (const p of worked) {
    out.push(`### ${p.name}${p.state === 'done' ? ' (완료)' : ''}`);
    for (const d of p.done) out.push(`- ${d.title}${d.workspace ? ` (${d.workspace})` : ''}${d.byUser ? ' [직접]' : ''}`);
    const subjects = p.commits.map((c) => c.subject).filter(Boolean);
    if (p.commitCount) out.push(`- 커밋 ${p.commitCount}건${p.mains ? `, 기준 브랜치 반영 ${p.mains}회` : ''}${subjects.length ? `: ${subjects.slice(0, 8).join(' / ')}${subjects.length > 8 ? ` 외 ${subjects.length - 8}건` : ''}` : ''}`);
  }
  const doing = b.projects.flatMap((p) => p.doing.map((d) => `- [${p.name}] ${d.title}${d.workspace ? ` (${d.workspace})` : ''}`));
  out.push('', '## 하는 중', ...(doing.length ? doing : ['- (없음)']));
  const next = b.projects.filter((p) => p.todoCount > 0).flatMap((p) => [...p.todo.slice(0, 5).map((d) => `- [${p.name}] ${d.title}${d.byUser ? ' [직접]' : ''}`), ...(p.todoCount > 5 ? [`- [${p.name}] 외 ${p.todoCount - 5}건`] : [])]);
  out.push('', '## 다음에 할 일', ...(next.length ? next : ['- (없음)']));
  if (b.waiting.length) out.push('', '## 확인이 필요한 것', ...b.waiting.slice(0, 15).map((w) => `- ${w.projectName ? `[${w.projectName}] ` : ''}${w.title}`));
  return out.join('\n');
}
