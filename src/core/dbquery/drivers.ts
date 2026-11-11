import mysql from 'mysql2';
import pg from 'pg';
import type { DbCell, DbColumn, DbKind, DbResult, DbTable } from '@shared/types';

export interface DbTarget { kind: DbKind; host: string; port: number; database: string; user: string; password: string; ssl: boolean }
export interface DbLimits { maxRows: number; timeoutMs: number }

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
  const kill = (): void => { try { (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy(); } catch { /* 이미 끊김 */ } };
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(lim.timeoutMs))}`);
    return await new Promise<DbResult>((resolve, reject) => {
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
    });
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(timer);
    // 되돌리고 닫는다. 이미 끊었으면 둘 다 실패해도 된다.
    await Promise.race([client.query('ROLLBACK').catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    kill();
    void client.end().catch(() => undefined);
  }
}

/**
 * MySQL 에서 문장 하나를 조회 전용으로 실행한다.
 * - 읽기 전용 트랜잭션 안에서 실행한다. 여러 문장 실행은 꺼 둔다 (서버가 한 문장만 받는다).
 * - 행을 하나씩 받다가 상한을 넘으면 연결을 끊는다.
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
    const rows: DbCell[][] = [];
    let columns: string[] = [];
    const timer = setTimeout(() => stop(new Error(`조회가 ${Math.round(lim.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`)), lim.timeoutMs + CONNECT_MS + 2000);
    const stop = (err: Error | null, truncated = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch { /* 이미 끊김 */ }
      if (err) reject(err); else resolve({ columns, rows, truncated, ms: Date.now() - started });
    };
    conn.on('error', (e) => stop(fail(e)));
    const step = (text: string, next: () => void): void => { conn.query(text, (e) => (e ? stop(fail(e)) : next())); };
    step('SET SESSION TRANSACTION READ ONLY', () =>
      // 서버가 이 변수를 모르면(MariaDB 등) 넘어간다. 그때는 위의 시간 제한이 막는다.
      conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(lim.timeoutMs))}`, () =>
        step('START TRANSACTION READ ONLY', () => {
          const q = conn.query({ sql, values: params, rowsAsArray: true });
          q.on('fields', (fields: { name: string }[] | undefined) => { if (fields && columns.length === 0) columns = fields.map((f) => f.name); });
          q.on('result', (row: unknown) => {
            if (done || !Array.isArray(row)) return;
            if (rows.length >= lim.maxRows) { stop(null, true); return; }
            rows.push(row.map(cell));
          });
          q.on('error', (e: unknown) => stop(fail(e)));
          q.on('end', () => stop(null));
        })));
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
