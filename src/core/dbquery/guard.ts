import type { DbKind } from '@shared/types';

/**
 * 조회 전용 강제의 첫 겹: 실행하기 전에 글을 보고 거른다.
 * 이것만 믿지 않는다. 뒤에 읽기 전용 트랜잭션과 "한 문장만 받는 실행 방식" 이 있다 (drivers 참고).
 * 여기서 하는 일: 문장이 하나인지, 조회 계열로 시작하는지, 읽기 전용 트랜잭션으로 막히지 않는 것(서버 파일 쓰기, 행 잠금)이 없는지.
 */

const ALLOWED: Record<DbKind, string[]> = {
  postgres: ['select', 'with', 'show', 'explain', 'table', 'values'],
  mysql: ['select', 'with', 'show', 'explain', 'describe', 'desc', 'table', 'values'],
};

/**
 * 문자열, 식별자 따옴표, 주석을 지운 글을 돌려준다. 남는 것은 SQL 의 뼈대다.
 * 닫히지 않은 따옴표나 주석이 있으면 null: 어디까지가 글자열인지 알 수 없으므로 받지 않는다.
 */
export function skeleton(sql: string, kind: DbKind): string | null {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    // MySQL 은 -- 뒤에 공백이나 제어 문자가 와야 주석이다. `5 --1` 은 5 - (-1) 이다: 주석으로 보면 뒤에 숨은 글을 놓친다.
    const dash = two === '--' && (kind === 'postgres' || i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]!));
    if (dash || (kind === 'mysql' && c === '#')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
    } else if (two === '/*') {
      // PostgreSQL 은 주석이 겹칠 수 있다.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.startsWith('/*', i) && kind === 'postgres') { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++;
      }
      if (depth > 0) return null;
      out += ' ';
    } else if (c === "'" || c === '"' || (kind === 'mysql' && c === '`')) {
      // 같은 따옴표를 두 번 쓰면 따옴표 한 글자다. MySQL 은 역슬래시로도 벗어난다.
      // PostgreSQL 의 E'..' 도 역슬래시를 쓰지만, 보통 문자열로 읽어도 닫는 곳을 더 일찍 볼 뿐이라 뼈대에 글자가 더 남는다 (더 엄격해진다).
      const escapes = kind === 'mysql' && c !== '`';
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return null;
      out += " '' ";
    } else if (kind === 'postgres' && c === '$') {
      // $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (!m) { out += c; i++; continue; }
      const end = sql.indexOf(m[0], i + m[0].length);
      if (end === -1) return null;
      i = end + m[0].length;
      out += " '' ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 조회 전용으로 받을 수 있는 문장인지 본다. 안 되면 이유를 던진다. 실행할 글(끝의 ; 를 뗀 것)을 돌려준다. */
export function checkReadOnly(sql: string, kind: DbKind): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('조회할 문장이 비어 있습니다.');
  if (sql.length > 20_000) throw new Error('문장이 너무 깁니다 (20000자까지).');
  if (sql.includes('\0')) throw new Error('문장에 쓸 수 없는 글자가 있습니다.');
  // MySQL 은 /*! ... */ 안의 글을 실행한다. 주석으로 보고 지우면 숨은 글을 놓친다.
  if (kind === 'mysql' && /\/\*[!M]/.test(sql)) throw new Error('/*! ... */ 형태의 실행되는 주석은 쓸 수 없습니다.');
  // 힌트로 서버의 시간 제한을 풀 수 있다 (MAX_EXECUTION_TIME).
  if (kind === 'mysql' && sql.includes('/*+')) throw new Error('/*+ ... */ 형태의 힌트는 쓸 수 없습니다.');
  // 아래 낱말은 문장의 어디에 있든(글자열 안이어도) 받지 않는다. 뼈대를 만드는 규칙이 서버의 해석과 어긋나는 경우에도 놓치지 않기 위해서다.
  // 읽기 전용 트랜잭션으로 막히지 않는 것들이다: 서버 파일 읽기·쓰기, 다른 세션 끊기, 서버 설정, 다른 DB 로 나가기.
  const raw = sql.toLowerCase();
  const banned = kind === 'mysql'
    ? ['outfile', 'dumpfile', 'load_file', 'get_lock', 'benchmark']
    : ['pg_read_file', 'pg_read_binary_file', 'pg_ls_', 'pg_stat_file', 'lo_export', 'lo_import', 'lo_from_bytea', 'lo_put', 'dblink', 'pg_terminate_backend', 'pg_cancel_backend',
      'pg_reload_conf', 'pg_rotate_logfile', 'pg_promote', 'replication_slot', 'pg_switch_wal', 'pg_create_restore_point', 'pg_stat_reset', 'pg_logical_emit_message', 'set_config',
      'pg_advisory', 'pg_shadow', 'pg_authid', 'copy_from', 'pg_execute_server_program'];
  const hit = banned.find((w) => raw.includes(w));
  if (hit) throw new Error(`"${hit}" 이(가) 들어간 문장은 실행할 수 없습니다 (서버의 파일, 다른 세션, 설정에 닿을 수 있습니다).`);
  if (kind === 'mysql' && /lock[\s\S]{0,40}in[\s\S]{0,40}share[\s\S]{0,40}mode/.test(raw)) throw new Error('행을 잠그는 조회(LOCK IN SHARE MODE)는 쓸 수 없습니다.');
  const bones = skeleton(sql, kind);
  if (bones === null) throw new Error('따옴표나 주석이 닫히지 않았습니다.');
  const body = bones.trim().replace(/;\s*$/, '').trim();
  if (!body) throw new Error('조회할 문장이 비어 있습니다.');
  if (body.includes(';')) throw new Error('문장은 하나만 실행할 수 있습니다.');
  const first = /^\(*\s*([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase() ?? '';
  if (!ALLOWED[kind].includes(first)) throw new Error(`조회 전용입니다. ${ALLOWED[kind].map((w) => w.toUpperCase()).join(', ')} 로 시작하는 문장만 실행할 수 있습니다.`);
  const flat = body.toLowerCase().replace(/\s+/g, ' ');
  // EXPLAIN ANALYZE 는 문장을 실제로 실행한다.
  if (first === 'explain' && /\banaly[sz]e\b/.test(flat)) throw new Error('EXPLAIN ANALYZE 는 문장을 실제로 실행하므로 쓸 수 없습니다.');
  // 읽기 전용 트랜잭션으로 막히지 않는 것: 서버의 파일에 쓰기, 행 잠금.
  if (/\binto (outfile|dumpfile)\b/.test(flat)) throw new Error('INTO OUTFILE, INTO DUMPFILE 은 쓸 수 없습니다.');
  if (/\bfor (update|share|no key update|key share)\b/.test(flat) || /\block in share mode\b/.test(flat)) throw new Error('행을 잠그는 조회(FOR UPDATE 등)는 쓸 수 없습니다.');
  return sql.trim().replace(/;\s*$/, '');
}
