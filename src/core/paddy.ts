import type Database from 'better-sqlite3';
import type { PaddyDay } from '@shared/types';

const pad = (n: number): string => String(n).padStart(2, '0');
/** 이 PC 의 날짜 (YYYY-MM-DD) */
export const dayOf = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** 점수: TODO 끝냄 1, 커밋 1, main 반영 3 */
export const paddyScore = (d: { todos: number; commits: number; mains: number }): number => d.todos + d.commits + d.mains * 3;

/**
 * 두레 논: 날마다 한 일을 모아 깃허브 잔디처럼 한 칸씩 보인다. 끝낸 TODO 는 TODO 표에서, 커밋과 main 반영은 두레가 적어 둔 기록에서 센다.
 * LLM 을 부르지 않는다.
 */
export class PaddyService {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  /** 커밋(커밋 창, 자동 반영)과 main 반영(합치기, 자동 반영)을 적는다. */
  note(kind: 'commit' | 'main', projectId: string, workspaceId: string | null): void {
    try { this.db.prepare('INSERT INTO work_events (kind, project_id, workspace_id, at) VALUES (?, ?, ?, ?)').run(kind, projectId, workspaceId, this.now()); } catch { /* 기록하지 못해도 일은 그대로다 */ }
  }

  /** 최근 days 일의 칸 (오래된 것부터). projectId 를 비우면 모든 프로젝트를 합친다. */
  days(projectId: string | null, days = 371): PaddyDay[] {
    const end = new Date(this.now()); end.setHours(0, 0, 0, 0);
    const start = end.getTime() - (days - 1) * 86_400_000;
    const map = new Map<string, PaddyDay>();
    for (let i = 0; i < days; i++) { const date = dayOf(start + i * 86_400_000 + 3_600_000); map.set(date, { date, todos: 0, commits: 0, mains: 0, score: 0 }); }
    const where = projectId ? 'AND project_id = ?' : '';
    const args = projectId ? [start, projectId] : [start];
    // 끝낸 일은 따로 적어 둔 기록에서 센다: todos 는 워크스페이스를 정리하면 함께 지워져 지난 칸이 비게 된다.
    for (const r of this.db.prepare(`SELECT at FROM work_done WHERE at >= ? ${where}`).all(...args) as { at: number }[]) {
      const d = map.get(dayOf(r.at)); if (d) d.todos++;
    }
    for (const r of this.db.prepare(`SELECT kind, at FROM work_events WHERE at >= ? ${where}`).all(...args) as { kind: string; at: number }[]) {
      const d = map.get(dayOf(r.at)); if (!d) continue;
      if (r.kind === 'commit') d.commits++; else if (r.kind === 'main') d.mains++;
    }
    const out = [...map.values()];
    for (const d of out) d.score = paddyScore(d);
    return out;
  }
}
