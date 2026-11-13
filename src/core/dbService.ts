import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { DbAccess, DbColumn, DbConnection, DbConnectionInput, DbKind, DbRequest, DbResult, DbTable } from '@shared/types';
import { checkReadOnly } from './dbquery/guard';
import { listColumns, listTables, riskyPrivileges, runReadOnly, type DbLimits, type DbTarget } from './dbquery/drivers';
import type { MessageService } from './messages';
import type { ProjectStore, WorkspaceStore } from './stores';

/** 비밀번호를 암호화해 보관하는 방법. 앱은 macOS 키체인(Electron safeStorage)을 쓴다. 코어는 Electron 을 모른다 */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}
/** 안전하게 보관할 방법이 없을 때: 비밀번호가 있는 연결을 저장하지 못하게 한다 (평문으로 두지 않는다). */
export const noSecrets: SecretBox = {
  encrypt() { throw new Error('이 환경에서는 비밀번호를 안전하게 저장할 수 없습니다.'); },
  decrypt() { throw new Error('저장된 비밀번호를 읽을 수 없습니다.'); },
};

interface Row {
  id: string; project_id: string; name: string; kind: string; host: string; port: number; database: string; user: string;
  ssl: number; agent_access: string; secret: string; created_at: number;
}

/** 사용자가 패널에서 볼 때의 상한 */
export const USER_LIMITS: DbLimits = { maxRows: 1000, timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 };
/** 에이전트가 받을 때의 상한 [사용자 결정: 100행, 10초] */
export const AGENT_LIMITS: DbLimits = { maxRows: 100, timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 };
/** 에이전트가 보낼 수 있는 문장의 길이. 승인 카드에서 사용자가 끝까지 읽을 수 있어야 한다 */
const AGENT_MAX_SQL = 4000;
/** 한 연결에서 에이전트의 조회가 동시에 도는 수 */
const MAX_RUNNING = 3;
const RISK_TTL_MS = 10 * 60_000;
/** 에이전트에게 돌려주는 결과 글의 상한. 넘으면 뒤의 행을 뺀다 */
const AGENT_MAX_CHARS = 60_000;
/** 승인을 기다리며 도구 호출을 붙잡아 두는 시간. 넘으면 "기다리는 중" 으로 돌려주고, 결정되면 메시지로 알린다 */
const WAIT_MS = 40_000;
const KEEP_REQUESTS = 50;

const KINDS: DbKind[] = ['postgres', 'mysql', 'oracle'];
const kindOf = (k: string): DbKind => (k === 'mysql' ? 'mysql' : k === 'oracle' ? 'oracle' : 'postgres');
const ACCESS: DbAccess[] = ['ask', 'auto', 'off'];
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const toConnection = (r: Row): DbConnection => ({
  id: r.id, projectId: r.project_id, name: r.name, kind: kindOf(r.kind), host: r.host, port: r.port,
  database: r.database, user: r.user, ssl: r.ssl === 1, agentAccess: ACCESS.includes(r.agent_access as DbAccess) ? r.agent_access as DbAccess : 'ask',
  hasPassword: r.secret !== '', createdAt: r.created_at,
});

type Runner = { run: typeof runReadOnly; tables: typeof listTables; columns: typeof listColumns; risks: typeof riskyPrivileges };
/** 어디에 누구로 접속하는지. 승인을 기다리는 사이에 연결이 바뀌었는지 볼 때 쓴다 */
const fingerprint = (r: Row): string => [r.kind, r.host, r.port, r.database, r.user, r.ssl].join('\n');
/**
 * 에이전트에게 돌려줄 오류. 접속 단계의 오류에는 호스트, 포트, 사용자 이름이 들어 있다: 그대로 넘기지 않는다.
 * 문장의 오류(없는 표, 문법)는 에이전트가 고칠 수 있게 그대로 준다.
 */
function agentError(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|getaddrinfo|authentication failed|Access denied for user|no pg_hba|password|SSL|certificate|응답하지 않습니다|Connection terminated|timeout expired/i.test(m)) {
    return new Error('DB 에 접속하지 못했다. 접속 정보는 사용자가 관리한다: 사용자에게 두레의 DB 탭에서 "접속 확인" 을 해 달라고 하라.');
  }
  return new Error(m);
}
interface Held extends DbRequest { result?: DbResult; waiter?: (r: Held) => void; announced: boolean; taken: boolean; target: string; running: boolean }
export type AgentAnswer = { kind: 'result'; result: DbResult; note: string } | { kind: 'pending'; requestId: string };

/**
 * 프로젝트의 DB 연결과 조회. 조회 전용이다: 문장을 먼저 거르고(guard), 읽기 전용 트랜잭션에서 한 문장만 실행한다(drivers).
 * 비밀번호는 암호화해 두고 화면에도 에이전트에게도 돌려주지 않는다.
 * 이벤트: 'changed' (projectId) — 연결이나 조회 요청이 바뀜
 */
export class DbService extends EventEmitter {
  private readonly requests = new Map<string, Held>();
  private readonly risks = new Map<string, { key: string; at: number; list: string[] }>();
  private readonly running = new Map<string, number>();

  constructor(private readonly d: {
    db: Database.Database; projects: ProjectStore; workspaces: WorkspaceStore; messages: MessageService; secrets: SecretBox;
    isProjectClosed(projectId: string): boolean;
    /** 시험에서 가짜 DB 로 바꾼다 */
    runner?: Runner;
    waitMs?: number;
  }) {
    super();
  }

  private get runner(): Runner { return this.d.runner ?? { run: runReadOnly, tables: listTables, columns: listColumns, risks: riskyPrivileges }; }

  private withWarnings(c: DbConnection, r: Row): DbConnection {
    const known = this.risks.get(r.id);
    return known && known.key === fingerprint(r) ? { ...c, warnings: known.list } : c;
  }

  /** 이 연결의 계정이 조회 말고 할 수 있는 것. 접속해서 알아내고 잠시 기억한다. */
  private async risk(r: Row, fresh = false): Promise<string[]> {
    const key = fingerprint(r);
    const known = this.risks.get(r.id);
    if (!fresh && known && known.key === key && Date.now() - known.at < RISK_TTL_MS) return known.list;
    const list = await this.runner.risks(this.target(r));
    this.risks.set(r.id, { key, at: Date.now(), list });
    return list;
  }

  list(projectId: string): DbConnection[] {
    return (this.d.db.prepare('SELECT * FROM db_connections WHERE project_id = ? ORDER BY created_at, name').all(projectId) as Row[]).map((r) => this.withWarnings(toConnection(r), r));
  }

  get(id: string): DbConnection | undefined {
    const r = this.d.db.prepare('SELECT * FROM db_connections WHERE id = ?').get(id) as Row | undefined;
    return r ? this.withWarnings(toConnection(r), r) : undefined;
  }

  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM db_connections WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error('DB 연결이 없습니다.');
    return r;
  }

  private target(r: Row): DbTarget {
    return { kind: kindOf(r.kind), host: r.host, port: r.port, database: r.database, user: r.user, ssl: r.ssl === 1, password: r.secret ? this.d.secrets.decrypt(r.secret) : '' };
  }

  private clean(i: DbConnectionInput): Omit<DbConnectionInput, 'id' | 'password' | 'projectId'> {
    const name = oneLine(i?.name, 40);
    if (!name) throw new Error('연결 이름을 적으세요.');
    if (!KINDS.includes(i.kind)) throw new Error('지원하지 않는 DB 종류입니다.');
    const host = oneLine(i.host, 255);
    if (!host || /\s/.test(host)) throw new Error('호스트를 적으세요.');
    const port = Number(i.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트는 1~65535 사이의 숫자입니다.');
    const user = oneLine(i.user, 128);
    if (!user) throw new Error('사용자 이름을 적으세요.');
    const database = oneLine(i.database, 128);
    if (i.kind === 'postgres' && !database) throw new Error('데이터베이스 이름을 적으세요.');
    if (i.kind === 'oracle' && !database) throw new Error('서비스 이름을 적으세요 (예: ORCLPDB1).');
    if (!ACCESS.includes(i.agentAccess)) throw new Error('에이전트 사용 방식이 올바르지 않습니다.');
    return { name, kind: i.kind, host, port, database, user, ssl: i.ssl === true, agentAccess: i.agentAccess };
  }

  /** 연결을 등록하거나 고친다. 고칠 때 비밀번호를 주지 않으면 저장된 것을 그대로 둔다. */
  save(i: DbConnectionInput): DbConnection {
    const c = this.clean(i);
    const existing = i.id ? this.row(i.id) : undefined;
    const projectId = existing?.project_id ?? i.projectId;
    if (!this.d.projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다.');
    const clash = this.list(projectId).find((x) => x.name === c.name && x.id !== existing?.id);
    if (clash) throw new Error(`이미 있는 연결 이름입니다: ${c.name}`);
    const password = typeof i.password === 'string' ? i.password : undefined;
    if (password !== undefined && password.length > 1000) throw new Error('비밀번호가 너무 깁니다.');
    const secret = password === undefined ? existing?.secret ?? '' : password === '' ? '' : this.d.secrets.encrypt(password);
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      this.d.db.prepare('UPDATE db_connections SET name = ?, kind = ?, host = ?, port = ?, database = ?, user = ?, ssl = ?, agent_access = ?, secret = ? WHERE id = ?')
        .run(c.name, c.kind, c.host, c.port, c.database, c.user, c.ssl ? 1 : 0, c.agentAccess, secret, id);
    } else {
      this.d.db.prepare('INSERT INTO db_connections (id, project_id, name, kind, host, port, database, user, ssl, agent_access, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, c.name, c.kind, c.host, c.port, c.database, c.user, c.ssl ? 1 : 0, c.agentAccess, secret, Date.now());
    }
    this.emit('changed', projectId);
    return this.get(id)!;
  }

  remove(id: string): void {
    const r = this.row(id);
    this.d.db.prepare('DELETE FROM db_connections WHERE id = ?').run(id);
    // 그 연결을 기다리던 조회 요청은 거절로 끝낸다.
    for (const q of this.requests.values()) if (q.connectionId === id && q.status === 'pending') this.settle(q, 'denied', '연결이 지워졌다');
    this.emit('changed', r.project_id);
  }

  /** 접속되는지 보고, 이 계정이 조회 말고 할 수 있는 것을 확인한다. 걸린 시간(ms)과 경고를 돌려준다. */
  async test(id: string): Promise<{ ms: number; warnings: string[] }> {
    const row = this.row(id);
    const r = await this.runner.run(this.target(row), 'SELECT 1', [], { maxRows: 1, timeoutMs: 8000 });
    const warnings = await this.risk(row, true);
    this.emit('changed', row.project_id);
    return { ms: r.ms, warnings };
  }

  tables(id: string): Promise<DbTable[]> { return this.runner.tables(this.target(this.row(id))); }

  columns(id: string, schema: string, table: string): Promise<DbColumn[]> {
    return this.runner.columns(this.target(this.row(id)), oneLine(schema, 200), oneLine(table, 200));
  }

  /** 사용자가 패널에서 조회한다. */
  query(id: string, sql: string): Promise<DbResult> {
    const r = this.row(id);
    const kind: DbKind = kindOf(r.kind);
    return this.runner.run(this.target(r), checkReadOnly(sql, kind), [], USER_LIMITS);
  }

  // ---- 에이전트 ----

  /** 에이전트가 이름으로 연결을 찾는다. 쓸 수 없는 연결은 없는 것과 같이 다루지 않고 이유를 알린다. */
  forAgent(projectId: string, name: string): Row {
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트다. DB 를 조회할 수 없다.');
    const wanted = oneLine(name, 40);
    const all = this.d.db.prepare('SELECT * FROM db_connections WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[];
    const r = all.find((x) => x.name === wanted);
    if (!r) throw new Error(`"${wanted}" 라는 DB 연결이 없다. 있는 연결: ${all.filter((x) => x.agent_access !== 'off').map((x) => `"${x.name}"`).join(', ') || '(없음. 사용자가 두레의 DB 탭에서 등록해야 한다)'}`);
    if (r.agent_access === 'off') throw new Error(`사용자가 "${wanted}" 연결을 에이전트가 쓰지 못하게 해 두었다. 필요하면 사용자에게 요청하라.`);
    return r;
  }

  async agentTables(projectId: string, name: string): Promise<DbTable[]> {
    const r = this.forAgent(projectId, name);
    try { return await this.runner.tables(this.target(r)); } catch (e) { throw agentError(e); }
  }

  async agentColumns(projectId: string, name: string, schema: string, table: string): Promise<DbColumn[]> {
    const r = this.forAgent(projectId, name);
    try { return await this.runner.columns(this.target(r), oneLine(schema, 200), oneLine(table, 200)); } catch (e) { throw agentError(e); }
  }

  /** 에이전트에게 돌려줄 크기로 줄인다. */
  private trim(result: DbResult): { result: DbResult; note: string } {
    let rows = result.rows;
    let cut = result.truncated;
    while (rows.length > 1 && JSON.stringify(rows).length > AGENT_MAX_CHARS) { rows = rows.slice(0, Math.ceil(rows.length / 2)); cut = true; }
    // 한 행이 상한을 넘으면 칸을 줄인다.
    if (rows.length === 1 && JSON.stringify(rows).length > AGENT_MAX_CHARS) {
      const per = Math.max(20, Math.floor(AGENT_MAX_CHARS / Math.max(1, rows[0]!.length)) - 20);
      rows = [rows[0]!.map((v) => (typeof v === 'string' && v.length > per ? `${v.slice(0, per)}… (${v.length}자)` : v))];
      cut = true;
    }
    return {
      result: { ...result, rows, truncated: cut },
      note: cut ? `결과가 잘렸다 (${rows.length}행만 돌려준다. 한 번에 ${AGENT_LIMITS.maxRows}행까지). 필요한 칸만 고르고 WHERE, LIMIT 로 좁혀라.` : `${rows.length}행`,
    };
  }

  /** 에이전트의 조회를 실행한다. 한 연결에서 동시에 도는 수를 제한한다 (실행마다 새 접속을 여므로 DB 의 접속 수를 채울 수 있다). */
  private async runAgent(r: Row, sql: string): Promise<DbResult> {
    const n = this.running.get(r.id) ?? 0;
    if (n >= MAX_RUNNING) throw new Error(`이 연결에서 조회가 이미 ${MAX_RUNNING}개 돌고 있다. 끝난 뒤에 다시 조회하라.`);
    this.running.set(r.id, n + 1);
    try { return await this.runner.run(this.target(r), sql, [], AGENT_LIMITS); } catch (e) { throw agentError(e); } finally { this.running.set(r.id, (this.running.get(r.id) ?? 1) - 1); }
  }

  /**
   * 에이전트가 조회한다. 바로 조회하는 연결이면 결과를, 승인을 받는 연결이면 사용자의 결정을 기다린다.
   * 오래 기다리게 되면 "기다리는 중" 으로 돌려주고, 결정되면 두레의 알림으로 알린다 (agentResult 로 결과를 받는다).
   */
  async agentQuery(workspaceId: string, name: string, sql: string): Promise<AgentAnswer> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('워크스페이스가 없다.');
    const r = this.forAgent(ws.projectId, name);
    const kind: DbKind = kindOf(r.kind);
    if (typeof sql === 'string' && sql.length > AGENT_MAX_SQL) throw new Error(`문장이 너무 길다 (${AGENT_MAX_SQL}자까지). 나눠서 조회하라.`);
    const checked = checkReadOnly(sql, kind);
    // 읽기 전용 계정이 아니면 "바로 조회" 여도 승인을 받는다: 읽기 전용 트랜잭션으로 막히지 않는 길이 있다.
    const warnings = await this.risk(r).catch(() => ['계정의 권한을 확인하지 못했습니다']);
    if (r.agent_access === 'auto' && warnings.length === 0) return { kind: 'result', ...this.trim(await this.runAgent(r, checked)) };
    const mine = [...this.requests.values()].filter((q) => q.workspaceId === workspaceId && q.status === 'pending');
    if (mine.length >= 3) throw new Error('승인을 기다리는 조회가 이미 3개다. 사용자의 결정을 기다려라.');
    const held: Held = {
      id: crypto.randomUUID(), projectId: ws.projectId, workspaceId, connectionId: r.id, connectionName: r.name,
      sql: checked, status: 'pending', createdAt: Date.now(), announced: false, taken: false, warnings, target: fingerprint(r), running: false,
    };
    this.requests.set(held.id, held);
    for (const old of [...this.requests.values()].filter((q) => q.status !== 'pending').slice(0, Math.max(0, this.requests.size - KEEP_REQUESTS))) this.requests.delete(old.id);
    this.emit('changed', ws.projectId);
    const decided = await new Promise<Held | null>((resolve) => {
      const timer = setTimeout(() => { held.waiter = undefined; resolve(null); }, this.d.waitMs ?? WAIT_MS);
      held.waiter = (q) => { clearTimeout(timer); resolve(q); };
    });
    if (!decided) { held.announced = true; return { kind: 'pending', requestId: held.id }; }
    return this.take(decided);
  }

  private take(q: Held): AgentAnswer {
    // 승인됐지만 아직 실행 중이면 기다리는 중이다.
    if (q.status === 'pending' || q.running) return { kind: 'pending', requestId: q.id };
    q.taken = true;
    if (q.status === 'denied') throw new Error(`사용자가 이 조회를 거절했다${q.error ? ` (${q.error})` : ''}. 같은 조회를 다시 요청하지 말고, 필요하면 사용자에게 이유를 물어라.`);
    if (q.status === 'failed' || !q.result) throw new Error(`조회가 실패했다: ${q.error ?? '알 수 없는 오류'}`);
    return { kind: 'result', ...this.trim(q.result) };
  }

  /** 기다리다 돌려보낸 조회의 결과를 에이전트가 받는다. 요청한 워크스페이스만 받을 수 있다. */
  agentResult(workspaceId: string, requestId: string): AgentAnswer {
    const q = this.requests.get(String(requestId));
    if (!q || q.workspaceId !== workspaceId) throw new Error('그런 조회 요청이 없다 (두레를 다시 켜면 요청은 사라진다. 다시 조회하라).');
    return this.take(q);
  }

  /** 결정을 기다리는 조회 요청. 완료된 프로젝트의 요청은 거절로 끝낸다. */
  pending(projectId: string): DbRequest[] {
    if (this.d.isProjectClosed(projectId)) {
      for (const q of this.requests.values()) if (q.projectId === projectId && q.status === 'pending') this.settle(q, 'denied', '프로젝트가 완료됐다');
      return [];
    }
    return [...this.requests.values()].filter((q) => q.projectId === projectId && q.status === 'pending')
      .map(({ id, projectId: p, workspaceId, connectionId, connectionName, sql, status, createdAt, warnings }) => ({ id, projectId: p, workspaceId, connectionId, connectionName, sql, status, createdAt, warnings }));
  }

  private settle(q: Held, status: Held['status'], error?: string, result?: DbResult): void {
    q.status = status; q.error = error; q.result = result; q.running = false;
    const waiter = q.waiter;
    q.waiter = undefined;
    if (waiter) { waiter(q); return; }
    // 도구 호출이 이미 돌아갔다: 두레의 알림으로 깨운다.
    if (!q.announced) return;
    const head = status === 'approved' ? '사용자가 DB 조회를 승인했고 두레가 실행했다.' : status === 'denied' ? '사용자가 DB 조회를 거절했다.' : '사용자가 DB 조회를 승인했지만 실행이 실패했다.';
    try {
      this.d.messages.send({ projectId: q.projectId, from: { kind: 'system' }, toWorkspaceId: q.workspaceId, title: 'DB 조회', body: `${head} db_result 도구에 request_id "${q.id}" 를 줘서 결과를 받아라.` });
    } catch { /* 알림 실패가 결정을 바꾸면 안 된다 */ }
  }

  /**
   * 사용자가 조회 요청을 결정한다. 승인하면 두레가 실행한다.
   * always: 이 연결을 "바로 조회" 로 바꾼다 (앞으로 묻지 않는다).
   */
  async decide(requestId: string, allow: boolean, o: { always?: boolean } = {}): Promise<void> {
    const q = this.requests.get(requestId);
    if (!q || q.status !== 'pending') throw new Error('결정을 기다리는 조회 요청이 아닙니다.');
    if (!allow) { this.settle(q, 'denied'); this.emit('changed', q.projectId); return; }
    // 요청한 뒤에 사정이 바뀌었으면 실행하지 않는다: 사용자는 요청 때의 연결을 보고 승인한 것이다.
    const now = this.d.db.prepare('SELECT * FROM db_connections WHERE id = ?').get(q.connectionId) as Row | undefined;
    const stale = this.d.isProjectClosed(q.projectId) ? '프로젝트가 완료됐다'
      : !now ? '연결이 지워졌다'
        : now.agent_access === 'off' ? '사용자가 이 연결을 에이전트가 쓰지 못하게 바꿨다'
          : fingerprint(now) !== q.target ? '요청한 뒤에 연결의 접속 정보가 바뀌었다. 다시 조회하라' : null;
    if (stale || !now) { this.settle(q, 'denied', stale ?? '연결이 지워졌다'); this.emit('changed', q.projectId); throw new Error(`실행하지 않았습니다: ${stale}.`); }
    // 두 번 눌러도 한 번만 실행한다.
    q.status = 'approved'; q.running = true;
    this.emit('changed', q.projectId);
    try {
      const result = await this.runAgent(now, checkReadOnly(q.sql, kindOf(now.kind)));
      // "앞으로 묻지 않기" 는 실행이 된 뒤에만 반영한다.
      if (o.always && now.agent_access === 'ask') this.d.db.prepare("UPDATE db_connections SET agent_access = 'auto' WHERE id = ? AND agent_access = 'ask'").run(now.id);
      this.settle(q, 'approved', undefined, result);
    } catch (e) {
      this.settle(q, 'failed', e instanceof Error ? e.message : String(e));
    }
    this.emit('changed', q.projectId);
  }

  /** 워크스페이스가 지워지거나 프로젝트가 닫힐 때: 기다리던 요청을 거절로 끝낸다. */
  dropWorkspace(workspaceId: string): void {
    for (const q of this.requests.values()) if (q.workspaceId === workspaceId && q.status === 'pending') { this.settle(q, 'denied', '워크스페이스가 없어졌다'); this.emit('changed', q.projectId); }
  }
}
