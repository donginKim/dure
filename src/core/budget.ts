import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { BudgetStatus } from '@shared/types';
import type { ProjectStore } from './stores';

/** 예산으로 세는 토큰: 입력 + 캐시에 쓴 것 + 출력 (캐시에서 읽은 것은 뺀다) */
const COUNTED = 'coalesce(sum(input + cache_write + output), 0)';
const startOfToday = (now: number): number => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * 프로젝트의 예산. 하루 상한과 전체 상한 (토큰). 80% 를 넘으면 알리고, 넘으면 그 프로젝트의 에이전트를 멈추고 새로 일을 시키지 못하게 한다.
 * 사용자가 상한을 올리거나 "오늘만 더 쓰기" 를 누르면 풀린다 (그날 자정까지).
 * 이벤트: 'changed' (projectId), 'over' (projectId) — 막 넘었다
 */
export class BudgetService extends EventEmitter {
  /** 사용자가 "오늘만 더 쓰기" 를 누른 때까지 (프로젝트마다) */
  private readonly override = new Map<string, number>();
  private readonly lastState = new Map<string, BudgetStatus['state']>();

  constructor(private readonly db: Database.Database, private readonly projects: ProjectStore, private readonly now: () => number = Date.now) { super(); }

  status(projectId: string): BudgetStatus {
    const p = this.projects.get(projectId);
    const now = this.now();
    const today = (this.db.prepare(`SELECT ${COUNTED} AS n FROM token_usage WHERE project_id = ? AND at >= ?`).get(projectId, startOfToday(now)) as { n: number }).n;
    const total = (this.db.prepare(`SELECT ${COUNTED} AS n FROM token_usage WHERE project_id = ?`).get(projectId) as { n: number }).n;
    const dailyLimit = p?.budgetDaily ?? 0;
    const totalLimit = p?.budgetTotal ?? 0;
    const overrideUntil = (this.override.get(projectId) ?? 0) > now ? this.override.get(projectId)! : 0;
    const over = (dailyLimit > 0 && today >= dailyLimit) || (totalLimit > 0 && total >= totalLimit);
    const near = (dailyLimit > 0 && today >= dailyLimit * 0.8) || (totalLimit > 0 && total >= totalLimit * 0.8);
    const state: BudgetStatus['state'] = over && !overrideUntil ? 'over' : over || near ? 'warning' : 'ok';
    return { projectId, today, total, dailyLimit, totalLimit, state, overrideUntil };
  }

  /** 새로 일을 시켜도 되는가. 안 되면 까닭 */
  blocked(projectId: string): string | null {
    const s = this.status(projectId);
    if (s.state !== 'over') return null;
    const which = s.dailyLimit > 0 && s.today >= s.dailyLimit ? `오늘의 상한(${s.dailyLimit.toLocaleString('ko-KR')} 토큰)` : `전체 상한(${s.totalLimit.toLocaleString('ko-KR')} 토큰)`;
    return `이 프로젝트가 예산 ${which}을 넘어 에이전트를 멈췄습니다. 현황 탭의 사용량에서 상한을 올리거나 "오늘만 더 쓰기" 를 누르세요.`;
  }

  /** 사용량이 늘었다: 상태가 바뀌었으면 알린다. */
  check(projectId: string): void {
    const s = this.status(projectId).state;
    const before = this.lastState.get(projectId);
    this.lastState.set(projectId, s);
    if (s === before) return;
    this.emit('changed', projectId);
    if (s === 'over') this.emit('over', projectId);
  }

  /** 오늘 자정까지는 넘어도 멈추지 않는다. */
  allowToday(projectId: string): void {
    const d = new Date(this.now()); d.setHours(24, 0, 0, 0);
    this.override.set(projectId, d.getTime());
    this.check(projectId);
    this.emit('changed', projectId);
  }

  setLimits(projectId: string, b: { daily: number; total: number }): void {
    this.projects.setBudget(projectId, b);
    this.check(projectId);
    this.emit('changed', projectId);
  }

  /** 예산이 넘었거나 가까운 프로젝트 (확인할 것에 올린다). */
  alerts(projectId: string): BudgetStatus[] {
    const s = this.status(projectId);
    return s.state === 'ok' ? [] : [s];
  }
}
