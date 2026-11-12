import type Database from 'better-sqlite3';
import type { TokenCount, UsageSummary } from '@shared/types';
import type { UsageLine } from './chat/transcript';
import type { WorkspaceStore } from './stores';

interface Sum { input: number | null; output: number | null; cache_write: number | null; cache_read: number | null; requests: number }
const toCount = (r: Sum): TokenCount => ({ input: r.input ?? 0, output: r.output ?? 0, cacheWrite: r.cache_write ?? 0, cacheRead: r.cache_read ?? 0, requests: r.requests });
const SUMS = 'sum(input) AS input, sum(output) AS output, sum(cache_write) AS cache_write, sum(cache_read) AS cache_read, count(*) AS requests';

/**
 * 에이전트가 쓴 토큰의 기록. 대화 기록(Claude Code 가 적는 파일)에서 모델의 답마다 적힌 수를 그대로 모은다.
 * 금액은 계산하지 않는다: 모델과 요금제에 따라 달라 두레가 알 수 없다.
 */
export class UsageStore {
  constructor(private readonly db: Database.Database, private readonly workspaces: WorkspaceStore) {}

  /** 같은 답은 한 번만 센다 (기록에는 같은 답이 여러 줄로 적힌다. 나중 것이 더 정확해 그것으로 바꾼다). */
  record(workspaceId: string, u: UsageLine): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    this.db.prepare(`INSERT INTO token_usage (message_id, workspace_id, project_id, workspace_name, model, input, output, cache_write, cache_read, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET input = excluded.input, output = excluded.output, cache_write = excluded.cache_write, cache_read = excluded.cache_read`)
      .run(u.messageId, ws.id, ws.projectId, ws.name, u.model, u.input, u.output, u.cacheWrite, u.cacheRead, u.at);
  }

  /** 프로젝트의 사용량. sinceMs 가 있으면 그 시각 이후의 것만. */
  summary(projectId: string, sinceMs = 0): UsageSummary {
    const args = [projectId, sinceMs];
    const where = 'WHERE project_id = ? AND at >= ?';
    const total = toCount(this.db.prepare(`SELECT ${SUMS} FROM token_usage ${where}`).get(...args) as Sum);
    const rows = this.db.prepare(`SELECT workspace_id, max(workspace_name) AS name, ${SUMS} FROM token_usage ${where} GROUP BY workspace_id ORDER BY sum(input + output + cache_write + cache_read) DESC`).all(...args) as (Sum & { workspace_id: string; name: string })[];
    const models = this.db.prepare(`SELECT model, ${SUMS} FROM token_usage ${where} GROUP BY model ORDER BY sum(output) DESC`).all(...args) as (Sum & { model: string })[];
    const first = (this.db.prepare(`SELECT min(at) AS at FROM token_usage ${where}`).get(...args) as { at: number | null }).at;
    return {
      total,
      workspaces: rows.map((r) => { const ws = this.workspaces.get(r.workspace_id); return { workspaceId: r.workspace_id, name: ws ? (ws.role === 'coordinator' ? '조율 에이전트' : ws.name) : r.name, gone: !ws, ...toCount(r) }; }),
      models: models.map((r) => ({ model: r.model || '(알 수 없음)', ...toCount(r) })),
      since: first,
    };
  }
}
