import type { DbAccess, DbCell, DbConnection, DbConnectionInput, DbKind, DbTable } from '@shared/types';

export const KIND_LABEL: Record<DbKind, string> = { postgres: 'PostgreSQL', mysql: 'MySQL' };
export const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306 };
export const ACCESS_LABEL: Record<DbAccess, string> = { ask: '물어보고 조회', auto: '바로 조회', off: '에이전트 사용 안 함' };
export const ACCESS_HELP: Record<DbAccess, string> = {
  ask: '에이전트가 표 목록과 스키마는 바로 보고, 데이터를 조회할 때마다 내 승인을 받습니다.',
  auto: '에이전트가 승인 없이 조회합니다 (조회 전용, 한 번에 100행·10초). 로컬 개발 DB 에 맞습니다.',
  off: '에이전트는 이 연결을 볼 수도 쓸 수도 없습니다. 나만 이 화면에서 조회합니다.',
};

/** 연결 등록 화면의 값. 포트는 글로 받는다 */
export interface DbForm { name: string; kind: DbKind; host: string; port: string; database: string; user: string; password: string; ssl: boolean; agentAccess: DbAccess }

export const emptyForm = (): DbForm => ({ name: '', kind: 'postgres', host: 'localhost', port: String(DEFAULT_PORT.postgres), database: '', user: '', password: '', ssl: false, agentAccess: 'ask' });
export const formOf = (c: DbConnection): DbForm => ({ name: c.name, kind: c.kind, host: c.host, port: String(c.port), database: c.database, user: c.user, password: '', ssl: c.ssl, agentAccess: c.agentAccess });

/** 저장할 수 없으면 이유. */
export function formProblem(f: DbForm): string | null {
  if (!f.name.trim()) return '연결 이름을 적으세요.';
  if (!f.host.trim()) return '호스트를 적으세요.';
  const port = Number(f.port);
  if (!/^\d+$/.test(f.port.trim()) || port < 1 || port > 65535) return '포트는 1~65535 사이의 숫자입니다.';
  if (!f.user.trim()) return '사용자 이름을 적으세요.';
  if (f.kind === 'postgres' && !f.database.trim()) return '데이터베이스 이름을 적으세요.';
  return null;
}

/**
 * 보낼 모양으로. 고칠 때 비밀번호 칸을 비워 두면 저장된 비밀번호를 그대로 둔다 (password 를 보내지 않는다).
 * 비밀번호를 지우려면 clearPassword.
 */
export function toInput(f: DbForm, projectId: string, editing: DbConnection | null, clearPassword = false): DbConnectionInput {
  const base: DbConnectionInput = {
    projectId, name: f.name.trim(), kind: f.kind, host: f.host.trim(), port: Number(f.port), database: f.database.trim(), user: f.user.trim(), ssl: f.ssl, agentAccess: f.agentAccess,
  };
  if (editing) base.id = editing.id;
  if (clearPassword) base.password = '';
  else if (!editing || f.password !== '') base.password = f.password;
  return base;
}

/** 표를 누르면 조회 칸에 넣을 문장. 이름은 그 DB 의 방식으로 감싼다. */
export function previewSql(kind: DbKind, t: DbTable): string {
  const q = (s: string): string => (kind === 'mysql' ? `\`${s.replace(/`/g, '``')}\`` : `"${s.replace(/"/g, '""')}"`);
  const name = kind === 'postgres' && t.schema && t.schema !== 'public' ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  return `SELECT * FROM ${name} LIMIT 100`;
}

export const cellText = (v: DbCell): string => (v === null ? 'NULL' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
