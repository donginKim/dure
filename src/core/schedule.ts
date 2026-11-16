import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Schedule, ScheduleInput } from '@shared/types';

interface Row { id: string; project_id: string; workspace_id: string; title: string; prompt: string; kind: string; time: string; weekday: number | null; run_at: number | null; enabled: number; last_run_at: number | null; created_at: number }
const toSchedule = (r: Row): Schedule => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, title: r.title, prompt: r.prompt, kind: r.kind as Schedule['kind'],
  time: r.time, weekday: r.weekday, runAt: r.run_at, enabled: r.enabled === 1, lastRunAt: r.last_run_at, createdAt: r.created_at, nextAt: null,
});
const clean = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max);

/** 다음에 돌 때 (ms). 꺼져 있거나 이미 돈 한 번짜리면 null */
export function nextRun(s: Pick<Schedule, 'kind' | 'time' | 'weekday' | 'runAt' | 'enabled' | 'lastRunAt'>, now: number): number | null {
  if (!s.enabled) return null;
  if (s.kind === 'once') return s.lastRunAt ? null : s.runAt;
  const [h, m] = s.time.split(':').map(Number);
  const d = new Date(now); d.setHours(h ?? 9, m ?? 0, 0, 0);
  if (s.kind === 'weekly') d.setDate(d.getDate() + (((s.weekday ?? 1) - d.getDay() + 7) % 7));
  // 오늘(이번 주)의 그 시각에 아직 돌지 않았으면 그때, 이미 돌았으면 다음 번.
  if (s.lastRunAt !== null && s.lastRunAt >= d.getTime()) d.setDate(d.getDate() + (s.kind === 'weekly' ? 7 : 1));
  return d.getTime();
}

/**
 * 예약 실행: 정한 때에 워크스페이스의 에이전트에게 일을 시킨다 (매일, 매주, 한 번).
 * 때가 되면 두레의 메시지로 보낸다: 에이전트가 꺼져 있으면 설정에 따라 띄우고, 예산을 넘은 프로젝트면 보내지 않는다.
 * 두레가 꺼져 있던 동안 지나간 예약은 켜졌을 때 한 번만 돈다 (하루 넘게 지난 것은 건너뛴다).
 * 이벤트: 'changed'
 */
export class ScheduleService extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: {
    db: Database.Database;
    workspace(id: string): { id: string; projectId: string; name: string } | undefined;
    isProjectClosed(projectId: string): boolean;
    /** 보내지 못할 까닭 (예산 등). 없으면 null */
    blocked(projectId: string): string | null;
    send(projectId: string, workspaceId: string, body: string, title: string): void;
    now?: () => number;
  }) { super(); }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* 다음 번에 다시 본다 */ } }, 30_000);
    this.timer.unref?.();
  }
  dispose(): void { clearInterval(this.timer); }

  list(projectId: string): Schedule[] {
    const now = this.now();
    return (this.d.db.prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[]).map((r) => { const s = toSchedule(r); return { ...s, nextAt: nextRun(s, now) }; });
  }

  save(i: ScheduleInput): Schedule {
    const ws = this.d.workspace(String(i.workspaceId));
    if (!ws) throw new Error('워크스페이스가 없습니다.');
    if (this.d.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트입니다.');
    const title = clean(i.title, 80); const prompt = clean(i.prompt, 4000);
    if (!title) throw new Error('제목을 적으세요.');
    if (!prompt) throw new Error('시킬 일을 적으세요.');
    const kind = i.kind === 'weekly' || i.kind === 'once' ? i.kind : 'daily';
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(i.time)) ? String(i.time) : '09:00';
    const weekday = kind === 'weekly' ? Math.max(0, Math.min(6, Math.floor(Number(i.weekday ?? 1)))) : null;
    const runAt = kind === 'once' ? Number(i.runAt) : null;
    if (kind === 'once' && (!Number.isFinite(runAt) || runAt! < this.now() - 60_000)) throw new Error('한 번 돌릴 때는 지금보다 뒤의 시각이어야 합니다.');
    const n = (this.d.db.prepare('SELECT count(*) AS n FROM schedules WHERE project_id = ?').get(ws.projectId) as { n: number }).n;
    if (!i.id && n >= 50) throw new Error('예약은 프로젝트마다 50개까지입니다.');
    const id = i.id && this.d.db.prepare('SELECT 1 FROM schedules WHERE id = ?').get(i.id) ? i.id : crypto.randomUUID();
    this.d.db.prepare(`INSERT INTO schedules (id, project_id, workspace_id, title, prompt, kind, time, weekday, run_at, enabled, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, title = excluded.title, prompt = excluded.prompt, kind = excluded.kind, time = excluded.time, weekday = excluded.weekday, run_at = excluded.run_at, enabled = excluded.enabled`)
      // 새로 만든 매일·매주 예약은 지금을 "마지막으로 돈 때" 로 적는다: 오늘의 그 시각이 이미 지났어도 만들자마자 돌지 않는다.
      .run(id, ws.projectId, ws.id, title, prompt, kind, time, weekday, runAt, i.enabled === false ? 0 : 1, kind === 'once' ? null : this.now(), this.now());
    this.emit('changed');
    return this.list(ws.projectId).find((s) => s.id === id)!;
  }

  remove(id: string): void {
    if (this.d.db.prepare('DELETE FROM schedules WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }

  setEnabled(id: string, enabled: boolean): void {
    if (this.d.db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, String(id)).changes) this.emit('changed');
  }

  /** 지금 바로 한 번 돌린다 (때와 상관없이). */
  runNow(id: string): void {
    const r = this.d.db.prepare('SELECT * FROM schedules WHERE id = ?').get(String(id)) as Row | undefined;
    if (!r) throw new Error('예약이 없습니다.');
    const why = this.fire(r);
    if (why) throw new Error(why);
  }

  /** 때가 된 예약을 돌린다. */
  tick(): void {
    const now = this.now();
    for (const r of this.d.db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as Row[]) {
      const at = nextRun(toSchedule(r), now);
      if (at === null || at > now) continue;
      // 하루 넘게 지난 것은 건너뛴다 (오래 꺼 두었다 켰을 때 밀린 일이 한꺼번에 돌지 않게).
      if (now - at > 86_400_000) { this.d.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(now, r.id); continue; }
      this.fire(r);
    }
  }

  /** 보낸다. 보내지 못했으면 까닭을 돌려준다 (그래도 이번 차례는 지난 것으로 적어 되풀이하지 않는다). */
  private fire(r: Row): string | null {
    const now = this.now();
    this.d.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(now, r.id);
    this.emit('changed');
    if (!this.d.workspace(r.workspace_id)) return '워크스페이스가 없습니다.';
    if (this.d.isProjectClosed(r.project_id)) return '완료된 프로젝트입니다.';
    const blocked = this.d.blocked(r.project_id);
    if (blocked) return blocked;
    try {
      this.d.send(r.project_id, r.workspace_id, `[두레 예약] 사용자가 정해 둔 때가 되어 두레가 보낸다 (예약 "${r.title}"). 아래 일을 하라.\n\n${r.prompt}`, `예약: ${r.title}`);
      return null;
    } catch (e) { return e instanceof Error ? e.message : String(e); }
  }
}
