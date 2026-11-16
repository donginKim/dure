import type Database from 'better-sqlite3';
import type { DailyDigest } from '@shared/types';
import { dayOf } from './paddy';

/**
 * 하루 결산: 그날 끝낸 TODO, 커밋, main 반영, 쓴 토큰, 근무시간을 이미 있는 기록에서 모은다 (LLM 을 부르지 않는다).
 * 아침 브리핑은 어제의 결산에, 지금 기다리는 것과 오늘 이어 갈 일을 더해 화면이 만든다.
 */
export class DigestService {
  constructor(private readonly d: {
    db: Database.Database;
    projects(): { id: string; name: string; status: string }[];
    workspaceName(id: string): string;
    workMs(day: string): number;
    attention(): { title: string; projectName: string }[];
    now?: () => number;
  }) {}

  /** offsetDays: 0 이면 오늘, 1 이면 어제 */
  daily(offsetDays = 0): DailyDigest {
    const now = this.d.now?.() ?? Date.now();
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - Math.max(0, Math.min(30, Math.floor(offsetDays))));
    const t0 = start.getTime(); const t1 = t0 + 86_400_000;
    const day = dayOf(t0 + 3_600_000);
    const names = new Map(this.d.projects().map((p) => [p.id, p.name]));
    const by = new Map<string, DailyDigest['projects'][number]>();
    const at = (projectId: string): DailyDigest['projects'][number] => {
      let p = by.get(projectId);
      if (!p) { p = { projectId, name: names.get(projectId) ?? '지운 프로젝트', done: [], commits: 0, mains: 0, tokens: 0 }; by.set(projectId, p); }
      return p;
    };
    for (const r of this.d.db.prepare("SELECT project_id, workspace_id, title FROM todos WHERE status = 'done' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at").all(t0, t1) as { project_id: string; workspace_id: string | null; title: string }[]) {
      at(r.project_id).done.push({ title: r.title, workspace: r.workspace_id ? this.d.workspaceName(r.workspace_id) : '' });
    }
    for (const r of this.d.db.prepare('SELECT project_id, kind, count(*) AS n FROM work_events WHERE at >= ? AND at < ? GROUP BY project_id, kind').all(t0, t1) as { project_id: string; kind: string; n: number }[]) {
      if (r.kind === 'commit') at(r.project_id).commits += r.n; else if (r.kind === 'main') at(r.project_id).mains += r.n;
    }
    for (const r of this.d.db.prepare('SELECT project_id, coalesce(sum(input + cache_write + output), 0) AS n FROM token_usage WHERE at >= ? AND at < ? GROUP BY project_id').all(t0, t1) as { project_id: string; n: number }[]) {
      if (r.n > 0) at(r.project_id).tokens = r.n;
    }
    const projects = [...by.values()].sort((a, b) => b.done.length - a.done.length || b.tokens - a.tokens);
    // 지금 하는 중인 일과 남은 일 (진행 중인 프로젝트만)
    const open = new Set(this.d.projects().filter((p) => p.status !== 'done').map((p) => p.id));
    const doing = (this.d.db.prepare("SELECT project_id, title FROM todos WHERE status = 'doing' ORDER BY updated_at DESC LIMIT 30").all() as { project_id: string; title: string }[])
      .filter((r) => open.has(r.project_id)).map((r) => ({ title: r.title, project: names.get(r.project_id) ?? '' }));
    const todo = (this.d.db.prepare("SELECT project_id FROM todos WHERE status = 'todo'").all() as { project_id: string }[]).filter((r) => open.has(r.project_id)).length;
    return {
      day, projects,
      totals: {
        done: projects.reduce((n, p) => n + p.done.length, 0), commits: projects.reduce((n, p) => n + p.commits, 0),
        mains: projects.reduce((n, p) => n + p.mains, 0), tokens: projects.reduce((n, p) => n + p.tokens, 0), workMs: this.d.workMs(day),
      },
      doing, todo,
      attention: offsetDays === 0 ? this.d.attention().slice(0, 20) : [],
    };
  }
}
