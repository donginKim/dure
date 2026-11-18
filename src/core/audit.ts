import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { AuditActorKind, AuditEntry, AuditFilter, AuditOutcome, AuditVerify } from '@shared/types';

// eslint-disable-next-line no-control-regex
const line = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const ACTORS: AuditActorKind[] = ['user', 'agent', 'peer', 'system'];
const OUTCOMES: AuditOutcome[] = ['ok', 'denied', 'failed'];

export interface AuditInput {
  /** 누가: 사용자, 에이전트(워크스페이스), 다른 사람(피어), 두레가 스스로 */
  actor: AuditActorKind;
  /** 누구인지 보이는 이름 (에이전트면 워크스페이스 이름, 피어면 그 사람의 이름) */
  actorName?: string;
  /** 무엇을: 점으로 나눈 영문 이름. 바꾸지 않는다 (내보낸 기록을 받는 쪽이 이 이름으로 가린다) */
  action: string;
  projectId?: string | null; workspaceId?: string | null;
  /** 대상: 이름이나 식별자. 본문은 적지 않는다 */
  target?: string;
  outcome?: AuditOutcome;
  /** 근거나 까닭: 어느 승인, 어느 규칙, 왜 막혔나 */
  reason?: string;
  /** 덧붙이는 값 (작게: 개수, 크기, 모드 이름). 본문·비밀 값은 넣지 않는다 */
  detail?: Record<string, string | number | boolean | null>;
}

interface Row { seq: number; at: number; actor: string; actor_name: string; action: string; project_id: string; workspace_id: string; target: string; outcome: string; reason: string; detail: string; prev: string; hash: string }
const toEntry = (r: Row): AuditEntry => {
  let detail: AuditEntry['detail'] = {};
  try { detail = JSON.parse(r.detail) as AuditEntry['detail']; } catch { /* 빈 것으로 */ }
  return { seq: r.seq, at: r.at, actor: r.actor as AuditActorKind, actorName: r.actor_name, action: r.action, projectId: r.project_id, workspaceId: r.workspace_id, target: r.target, outcome: r.outcome as AuditOutcome, reason: r.reason, detail, hash: r.hash };
};

/** 한 줄의 지문: 앞 줄의 지문과 이 줄의 내용. 줄을 고치거나 빼면 그 뒤의 지문이 모두 어긋난다. */
function hashOf(prev: string, r: Omit<Row, 'seq' | 'prev' | 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([prev, r.at, r.actor, r.actor_name, r.action, r.project_id, r.workspace_id, r.target, r.outcome, r.reason, r.detail])).digest('hex');
}

/**
 * 감사 기록: 누가 무엇을 했고 어떻게 됐는지를 한 줄씩 적는다. 납품과 점검에 쓴다.
 * - 본문은 적지 않는다 (프롬프트, 조회 결과, 메시지 글, 비밀 값). 이름·종류·개수·결과만 적는다.
 * - 줄마다 앞 줄의 지문을 넣어 잇는다: 누가 중간의 줄을 고치거나 빼면 verify 가 어디서 어긋났는지 알려 준다.
 *   (같은 PC 의 같은 계정이 DB 파일을 통째로 다시 쓰는 것까지 막지는 못한다: 그것은 기록을 밖으로 내보내 따로 보관해야 한다.)
 * - 오래된 줄은 보관 기간이 지나면 지운다. 지운 자리의 마지막 지문을 닻으로 남겨, 남은 줄의 이어짐은 계속 확인된다.
 * 이벤트: 'changed'
 */
export class AuditLog extends EventEmitter {
  private last: string;
  private readonly insert;

  constructor(private readonly d: { db: Database.Database; now?: () => number; keepDays?: () => number }) {
    super();
    const tail = d.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    this.last = tail?.hash ?? this.meta('anchor_hash') ?? '';
    this.insert = d.db.prepare('INSERT INTO audit_log (at, actor, actor_name, action, project_id, workspace_id, target, outcome, reason, detail, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  }

  private meta(key: string): string | undefined {
    return (this.d.db.prepare('SELECT value FROM audit_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  private setMeta(key: string, value: string): void {
    this.d.db.prepare('INSERT INTO audit_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** 한 줄 적는다. 기록이 실패해도 하던 일을 막지 않는다 (던지지 않는다). */
  record(i: AuditInput): void {
    try {
      if (!this.d.db.open) return;
      const detail: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(i.detail ?? {}).slice(0, 12)) detail[line(k, 40)] = typeof v === 'string' ? line(v, 200) : v;
      const r = {
        at: (this.d.now ?? Date.now)(), actor: ACTORS.includes(i.actor) ? i.actor : 'system', actor_name: line(i.actorName, 80),
        action: line(i.action, 80).replace(/[^a-zA-Z0-9._-]/g, '_'), project_id: line(i.projectId, 80), workspace_id: line(i.workspaceId, 80),
        target: line(i.target, 200), outcome: OUTCOMES.includes(i.outcome as AuditOutcome) ? i.outcome as string : 'ok', reason: line(i.reason, 300), detail: JSON.stringify(detail),
      };
      const hash = hashOf(this.last, r);
      this.insert.run(r.at, r.actor, r.actor_name, r.action, r.project_id, r.workspace_id, r.target, r.outcome, r.reason, r.detail, this.last, hash);
      this.last = hash;
      this.emit('changed');
    } catch { /* 기록만 빠진다 */ }
  }

  private where(f: AuditFilter): { sql: string; args: unknown[] } {
    const parts: string[] = []; const args: unknown[] = [];
    if (f.actor && ACTORS.includes(f.actor)) { parts.push('actor = ?'); args.push(f.actor); }
    if (f.outcome && OUTCOMES.includes(f.outcome)) { parts.push('outcome = ?'); args.push(f.outcome); }
    if (f.projectId) { parts.push('project_id = ?'); args.push(String(f.projectId)); }
    if (f.action) { parts.push("action LIKE ? ESCAPE '\\'"); args.push(`${String(f.action).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (typeof f.since === 'number') { parts.push('at >= ?'); args.push(f.since); }
    if (typeof f.until === 'number') { parts.push('at <= ?'); args.push(f.until); }
    if (typeof f.before === 'number') { parts.push('seq < ?'); args.push(f.before); }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
  }

  /** 새것부터. before 로 이어 읽는다. */
  list(f: AuditFilter = {}): AuditEntry[] {
    const w = this.where(f);
    const limit = Math.max(1, Math.min(500, Math.floor(f.limit ?? 100)));
    return (this.d.db.prepare(`SELECT * FROM audit_log ${w.sql} ORDER BY seq DESC LIMIT ?`).all(...w.args, limit) as Row[]).map(toEntry);
  }

  count(f: AuditFilter = {}): number {
    const w = this.where({ ...f, before: undefined });
    return (this.d.db.prepare(`SELECT count(*) AS n FROM audit_log ${w.sql}`).get(...w.args) as { n: number }).n;
  }

  /** 이어짐을 처음부터 끝까지 확인한다. 어긋난 첫 줄의 번호를 돌려준다. */
  verify(): AuditVerify {
    let prev = this.meta('anchor_hash') ?? '';
    let n = 0; let first = 0; let lastSeq = 0;
    for (const r of this.d.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as IterableIterator<Row>) {
      if (n === 0) first = r.seq;
      // 줄이 빠졌거나(번호가 건너뜀) 앞 줄과 이어지지 않거나 내용이 고쳐졌으면 어긋난 것이다.
      if ((lastSeq && r.seq !== lastSeq + 1) || r.prev !== prev || r.hash !== hashOf(prev, r)) return { ok: false, count: n, brokenAt: r.seq, firstSeq: first, lastSeq: r.seq, pruned: Number(this.meta('pruned') ?? 0), head: prev };
      prev = r.hash; lastSeq = r.seq; n++;
    }
    return { ok: true, count: n, brokenAt: null, firstSeq: first, lastSeq, pruned: Number(this.meta('pruned') ?? 0), head: prev };
  }

  /**
   * 내보낸다 (오래된 것부터). JSONL 은 첫 줄에 이 묶음의 설명(어느 PC, 언제, 몇 줄, 이어짐 확인 결과, 마지막 지문)을 싣는다.
   * 받는 쪽은 줄마다의 hash 와 prev 로 이어짐을 스스로 다시 확인할 수 있다.
   */
  export(format: 'jsonl' | 'csv', f: AuditFilter, who: { host: string; user: string; app: string }): string {
    const w = this.where({ ...f, before: undefined });
    const rows = this.d.db.prepare(`SELECT * FROM audit_log ${w.sql} ORDER BY seq LIMIT 200000`).all(...w.args) as Row[];
    const v = this.verify();
    const iso = (at: number): string => new Date(at).toISOString();
    if (format === 'csv') {
      const cell = (x: unknown): string => { const t = String(x ?? ''); const safe = /^[=+\-@\t]/.test(t) ? `'${t}` : t; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
      const head = ['seq', 'time', 'actor', 'actor_name', 'action', 'outcome', 'project_id', 'workspace_id', 'target', 'reason', 'detail', 'prev', 'hash'];
      return [head.join(','), ...rows.map((r) => [r.seq, iso(r.at), r.actor, r.actor_name, r.action, r.outcome, r.project_id, r.workspace_id, r.target, r.reason, r.detail, r.prev, r.hash].map(cell).join(','))].join('\n') + '\n';
    }
    const meta = { type: 'meta', format: 'dure-audit/1', exportedAt: iso((this.d.now ?? Date.now)()), host: line(who.host, 100), osUser: line(who.user, 100), app: line(who.app, 40), rows: rows.length, chainOk: v.ok, brokenAt: v.brokenAt, head: v.head, prunedBefore: v.pruned, hash: 'sha256(JSON.stringify([prev, at, actor, actorName, action, projectId, workspaceId, target, outcome, reason, detailJson]))' };
    return [JSON.stringify(meta), ...rows.map((r) => JSON.stringify({ seq: r.seq, at: r.at, time: iso(r.at), actor: r.actor, actorName: r.actor_name, action: r.action, outcome: r.outcome, projectId: r.project_id, workspaceId: r.workspace_id, target: r.target, reason: r.reason, detail: r.detail, prev: r.prev, hash: r.hash }))].join('\n') + '\n';
  }

  /** 보관 기간이 지난 줄을 지운다 (0 이면 지우지 않는다). 지운 마지막 줄의 지문을 닻으로 남긴다. */
  prune(): number {
    const days = Math.floor(this.d.keepDays?.() ?? 0);
    if (!(days > 0) || !this.d.db.open) return 0;
    const cut = (this.d.now ?? Date.now)() - days * 86_400_000;
    const lastOld = this.d.db.prepare('SELECT seq, hash FROM audit_log WHERE at < ? ORDER BY seq DESC LIMIT 1').get(cut) as { seq: number; hash: string } | undefined;
    if (!lastOld) return 0;
    let n = 0;
    this.d.db.transaction(() => {
      // 닻은 지우는 범위의 마지막 줄이다: 그 줄까지 이어져 있었다는 것을 남은 첫 줄의 prev 가 증명한다.
      n = this.d.db.prepare('DELETE FROM audit_log WHERE seq <= ?').run(lastOld.seq).changes;
      this.setMeta('anchor_hash', lastOld.hash);
      this.setMeta('pruned', String(Number(this.meta('pruned') ?? 0) + n));
    })();
    this.record({ actor: 'system', action: 'audit.prune', target: `${n}`, reason: `보관 기간 ${days}일`, detail: { removed: n, keepDays: days } });
    return n;
  }
}
