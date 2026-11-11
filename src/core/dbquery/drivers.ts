import mysql from 'mysql2';
import pg from 'pg';
import type { DbCell, DbColumn, DbKind, DbResult, DbTable } from '@shared/types';

export interface DbTarget { kind: DbKind; host: string; port: number; database: string; user: string; password: string; ssl: boolean }
export interface DbLimits {
  maxRows: number; timeoutMs: number;
  /** 서버에서 받는 바이트의 상한. 큰 칸 하나가 메모리를 채우지 못하게 한다. 없으면 64MB */
  maxBytes?: number;
}
const DEFAULT_BYTES = 64 * 1024 * 1024;
const tooBig = (lim: DbLimits): Error => new Error(`결과가 너무 큽니다 (${Math.round((lim.maxBytes ?? DEFAULT_BYTES) / 1024 / 1024)}MB 넘음). 필요한 칸만 고르고 LIMIT 로 좁히세요.`);

const CONNECT_MS = 8000;
const MAX_CELL = 2000;

/** 결과 한 칸을 화면과 에이전트에게 보낼 수 있는 값으로. 긴 글과 이진 값은 줄인다. */
export function cell(v: unknown): DbCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.subarray(0, 32).toString('hex')}${v.length > 32 ? `… (${v.length}바이트)` : ''}`;
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}… (${s.length}자)` : s;
}

/** DB 가 낸 오류를 한 줄로. 접속 정보(비밀번호)는 오류 글에 들어 있지 않지만, 길이는 줄인다. */
const fail = (e: unknown): Error => new Error(String((e as { message?: string })?.message ?? e).replace(/\s+/g, ' ').slice(0, 500) || 'DB 오류');

/**
 * PostgreSQL 에서 문장 하나를 조회 전용으로 실행한다.
 * - 읽기 전용 트랜잭션 안에서 실행하고 끝나면 되돌린다.
 * - 확장 질의 방식으로 보낸다: 서버가 문장을 하나만 받는다 ("COMMIT; DELETE ..." 가 통하지 않는다).
 * - 행을 하나씩 받다가 상한을 넘으면 연결을 끊는다. 큰 표 전체를 메모리에 올리지 않는다.
 * - 실행마다 새 연결을 쓰고 닫는다.
 */
async function runPostgres(t: DbTarget, sql: string, params: unknown[], lim: DbLimits): Promise<DbResult> {
  const client = new pg.Client({
    host: t.host, port: t.port, database: t.database, user: t.user, password: t.password,
    ssl: t.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: CONNECT_MS, application_name: 'dure (read-only)',
  });
  // 연결이 끊길 때 나는 오류가 처리되지 않은 예외가 되지 않게 한다.
  client.on('error', () => undefined);
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  type Stream = { destroy(): void; on(ev: 'data', fn: (chunk: Buffer) => void): void };
  const stream = (): Stream | undefined => (client as unknown as { connection?: { stream?: Stream } }).connection?.stream;
  const kill = (): void => { try { stream()?.destroy(); } catch { /* 이미 끊김 */ } };
  // 접속부터 끝까지의 전체 제한. 로그인 뒤 서버가 아무 말도 하지 않는 경우에도 돌아온다.
  let abort: (e: Error) => void = () => undefined;
  const overall = new Promise<never>((_, reject) => { abort = reject; });
  overall.catch(() => undefined);
  const whole = setTimeout(() => { kill(); abort(new Error(`조회가 ${Math.round(lim.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`)); }, CONNECT_MS + lim.timeoutMs + 3000);
  try {
    await Promise.race([client.connect(), overall]);
    // 받은 바이트를 센다. 상한을 넘으면 끊는다 (칸 하나가 수백 MB 여도 다 받지 않는다).
    let bytes = 0;
    stream()?.on('data', (chunk) => { bytes += chunk.length; if (bytes > (lim.maxBytes ?? DEFAULT_BYTES)) { kill(); abort(tooBig(lim)); } });
    await Promise.race([client.query('BEGIN TRANSACTION READ ONLY'), overall]);
    await Promise.race([client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(lim.timeoutMs))}`), overall]);
    return await Promise.race([overall, new Promise<DbResult>((resolve, reject) => {
      const rows: DbCell[][] = [];
      let columns: string[] = [];
      let done = false;
      const finish = (truncated: boolean): void => {
        if (done) return;
        done = true;
        resolve({ columns, rows, truncated, ms: Date.now() - started });
      };
      // 서버의 시간 제한이 듣지 않는 경우(연결이 멈춤)를 위한 두 번째 제한.
      timer = setTimeout(() => { if (!done) { done = true; kill(); reject(new Error(`조회가 ${Math.round(lim.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`)); } }, lim.timeoutMs + 2000);
      const q = new pg.Query({ text: sql, values: params, rowMode: 'array', queryMode: 'extended' } as pg.QueryArrayConfig);
      q.on('row', (row: unknown[], result?: { fields?: { name: string }[] }) => {
        if (done) return;
        if (columns.length === 0 && result?.fields) columns = result.fields.map((f) => f.name);
        if (rows.length >= lim.maxRows) { finish(true); kill(); return; }
        rows.push(row.map(cell));
      });
      q.on('end', (result?: { fields?: { name: string }[] }) => {
        if (columns.length === 0 && result?.fields) columns = result.fields.map((f) => f.name);
        finish(false);
      });
      q.on('error', (e: unknown) => { if (!done) { done = true; reject(fail(e)); } });
      client.query(q);
    })]);
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(timer);
    clearTimeout(whole);
    // 되돌리고 닫는다. 이미 끊었으면 둘 다 실패해도 된다.
    await Promise.race([client.query('ROLLBACK').catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    kill();
    void client.end().catch(() => undefined);
  }
}

/** 끊긴 뒤에도 서버에서 계속 도는 조회를 멈춘다 (다른 연결로 KILL QUERY). 실패해도 된다. */
function killMysqlQuery(t: DbTarget, threadId: number | undefined): void {
  if (!threadId || !Number.isInteger(threadId)) return;
  try {
    const c = mysql.createConnection({ host: t.host, port: t.port, user: t.user, password: t.password, ssl: t.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 4000 });
    c.on('error', () => undefined);
    c.query(`KILL QUERY ${threadId}`, () => { try { c.destroy(); } catch { /* 이미 끊김 */ } });
    setTimeout(() => { try { c.destroy(); } catch { /* 이미 끊김 */ } }, 5000).unref();
  } catch { /* 멈추지 못해도 조회 결과에는 영향이 없다 */ }
}

/** 서버의 모드가 달라도 글자열 규칙이 같도록 고정한다: 역슬래시는 벗어남 글자이고, 큰따옴표는 글자열이다. 문장 검사(guard)가 이 규칙을 전제로 한다. */
const MYSQL_MODE = "SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

/**
 * MySQL 에서 문장 하나를 조회 전용으로 실행한다.
 * - 읽기 전용 트랜잭션 안에서 실행한다. 여러 문장 실행은 꺼 둔다 (서버가 한 문장만 받는다).
 * - 행을 하나씩 받다가 상한을 넘으면 연결을 끊고, 서버에서 도는 조회도 멈춘다.
 */
function runMysql(t: DbTarget, sql: string, params: unknown[], lim: DbLimits): Promise<DbResult> {
  return new Promise<DbResult>((resolve, reject) => {
    const started = Date.now();
    const conn = mysql.createConnection({
      host: t.host, port: t.port, database: t.database || undefined, user: t.user, password: t.password,
      ssl: t.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: CONNECT_MS, multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    });
    let done = false;
    let running = false;
    const rows: DbCell[][] = [];
    let columns: string[] = [];
    // 접속과 준비 단계의 제한. 조회를 보내면 조회의 제한으로 바꾼다.
    let timer = setTimeout(() => stop(new Error('DB 가 응답하지 않습니다.')), CONNECT_MS + 4000);
    const stop = (err: Error | null, truncated = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const threadId = (conn as unknown as { threadId?: number }).threadId;
      try { conn.destroy(); } catch { /* 이미 끊김 */ }
      // 끝까지 받지 않고 끊었으면 서버에서는 아직 돌고 있을 수 있다.
      if (running && (err || truncated)) killMysqlQuery(t, threadId);
      if (err) reject(err); else resolve({ columns, rows, truncated, ms: Date.now() - started });
    };
    conn.on('error', (e) => stop(fail(e)));
    let bytes = 0;
    (conn as unknown as { stream?: { on(ev: 'data', fn: (c: Buffer) => void): void } }).stream?.on('data', (chunk) => { bytes += chunk.length; if (bytes > (lim.maxBytes ?? DEFAULT_BYTES)) stop(tooBig(lim)); });
    const step = (text: string, next: () => void): void => { conn.query(text, (e) => (e ? stop(fail(e)) : next())); };
    step(MYSQL_MODE, () => step('SET SESSION TRANSACTION READ ONLY', () =>
      // 서버가 이 변수를 모르면(MariaDB 등) 넘어간다. 그때는 아래의 시간 제한이 끊고 KILL QUERY 로 멈춘다.
      conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(lim.timeoutMs))}`, () =>
        step('START TRANSACTION READ ONLY', () => {
          if (done) return;
          clearTimeout(timer);
          timer = setTimeout(() => stop(new Error(`조회가 ${Math.round(lim.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`)), lim.timeoutMs + 1000);
          running = true;
          const q = conn.query({ sql, values: params, rowsAsArray: true });
          q.on('fields', (fields: { name: string }[] | undefined) => { if (fields && columns.length === 0) columns = fields.map((f) => f.name); });
          q.on('result', (row: unknown) => {
            if (done || !Array.isArray(row)) return;
            if (rows.length >= lim.maxRows) { stop(null, true); return; }
            rows.push(row.map(cell));
          });
          q.on('error', (e: unknown) => stop(fail(e)));
          q.on('end', () => { running = false; stop(null); });
        }))));
  });
}

export function runReadOnly(t: DbTarget, sql: string, params: unknown[], lim: DbLimits): Promise<DbResult> {
  return t.kind === 'postgres' ? runPostgres(t, sql, params, lim) : runMysql(t, sql, params, lim);
}

const SCHEMA_LIMITS: DbLimits = { maxRows: 3000, timeoutMs: 15_000 };

/** 표와 뷰의 목록. 시스템 스키마는 뺀다. */
export async function listTables(t: DbTarget): Promise<DbTable[]> {
  const sql = t.kind === 'postgres'
    ? "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name"
    : 'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name';
  const r = await runReadOnly(t, sql, [], SCHEMA_LIMITS);
  return r.rows.map((x) => ({ schema: String(x[0] ?? ''), name: String(x[1] ?? ''), type: String(x[2] ?? '').toUpperCase().includes('VIEW') ? 'view' : 'table' }));
}

/** 표 하나의 칸 목록. 이름은 값으로 넘긴다 (문장에 끼워 넣지 않는다). */
export async function listColumns(t: DbTarget, schema: string, table: string): Promise<DbColumn[]> {
  const r = t.kind === 'postgres'
    ? await runReadOnly(t, `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
        (SELECT string_agg(tc.constraint_type, ', ') FROM information_schema.key_column_usage k
           JOIN information_schema.table_constraints tc ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema AND tc.table_name = k.table_name
          WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name)
        FROM information_schema.columns c WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`, [schema, table], SCHEMA_LIMITS)
    : await runReadOnly(t, 'SELECT column_name, column_type, is_nullable, column_default, column_key FROM information_schema.columns WHERE table_schema = COALESCE(NULLIF(?, \'\'), DATABASE()) AND table_name = ? ORDER BY ordinal_position', [schema, table], SCHEMA_LIMITS);
  return r.rows.map((x) => ({ name: String(x[0] ?? ''), type: String(x[1] ?? ''), nullable: String(x[2] ?? '').toUpperCase() === 'YES', default: x[3] === null ? null : String(x[3]), key: String(x[4] ?? '') }));
}

/**
 * 이 계정이 조회 말고 할 수 있는 것. 조회 전용 강제는 읽기 전용 트랜잭션에 기대는데, 권한이 높은 계정은 그 밖의 길이 있다
 * (서버 파일, 다른 세션 끊기 등). 그런 계정이면 화면에 경고하고 에이전트의 조회마다 승인을 받는다.
 * 알아내지 못하면 빈 목록이 아니라 "확인하지 못함" 을 돌려준다.
 */
export async function riskyPrivileges(t: DbTarget): Promise<string[]> {
  try {
    if (t.kind === 'postgres') {
      const r = await runReadOnly(t, `SELECT
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
          (SELECT bool_or(pg_has_role(current_user, r.rolname, 'member')) FROM pg_roles r WHERE r.rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program')),
          (SELECT bool_or(pg_has_role(current_user, r.rolname, 'member')) FROM pg_roles r WHERE r.rolname = 'pg_signal_backend'),
          has_database_privilege(current_database(), 'CREATE')`, [], SCHEMA_LIMITS);
      const [su, files, signal, create] = r.rows[0] ?? [];
      return [
        ...(su === true ? ['슈퍼유저입니다 (서버 파일, 설정, 다른 세션에 닿을 수 있습니다)'] : []),
        ...(su !== true && files === true ? ['서버의 파일을 읽거나 쓸 수 있습니다'] : []),
        ...(su !== true && signal === true ? ['다른 세션을 끊을 수 있습니다'] : []),
        ...(su !== true && create === true ? ['이 데이터베이스에 스키마를 만들 수 있습니다 (읽기 전용 계정이 아닙니다)'] : []),
      ];
    }
    const r = await runReadOnly(t, 'SHOW GRANTS', [], SCHEMA_LIMITS);
    const grants = r.rows.map((x) => String(x[0] ?? '').toUpperCase()).join('\n');
    const has = (w: string): boolean => new RegExp(`(GRANT|,)\\s*${w}\\b`).test(grants);
    return [
      ...(/ALL PRIVILEGES ON \*\.\*/.test(grants) || has('SUPER') ? ['관리자 권한이 있습니다 (서버 설정과 다른 세션에 닿을 수 있습니다)'] : []),
      ...(has('FILE') ? ['서버의 파일을 읽거나 쓸 수 있습니다 (FILE)'] : []),
      ...(/ALL PRIVILEGES/.test(grants) || ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER'].some(has) ? ['쓰기 권한이 있습니다 (읽기 전용 계정이 아닙니다)'] : []),
    ];
  } catch {
    return ['계정의 권한을 확인하지 못했습니다'];
  }
}
