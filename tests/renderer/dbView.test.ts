import type { DbConnection } from '@shared/types';
import { cellText, DEFAULT_PORT, emptyForm, formOf, formProblem, KIND_LABEL, previewSql, toInput } from '../../src/renderer/dbView';

const conn: DbConnection = { id: 'c1', projectId: 'p1', name: '운영', kind: 'mysql', host: 'db', port: 3306, database: 'shop', user: 'reader', ssl: true, agentAccess: 'auto', hasPassword: true, createdAt: 1 };

test('formProblem: 빈 칸과 잘못된 포트', () => {
  const f = { ...emptyForm(), name: 'a', user: 'u', database: 'd' };
  expect(formProblem(f)).toBeNull();
  expect(formProblem({ ...f, name: ' ' })).toContain('연결 이름');
  expect(formProblem({ ...f, host: '' })).toContain('호스트');
  expect(formProblem({ ...f, port: '0' })).toContain('포트');
  expect(formProblem({ ...f, port: '54a' })).toContain('포트');
  expect(formProblem({ ...f, user: '' })).toContain('사용자 이름');
  expect(formProblem({ ...f, database: '' })).toContain('데이터베이스');
  expect(formProblem({ ...f, kind: 'mysql', database: '' })).toBeNull();
});

test('toInput: 새 연결은 비밀번호를 보내고, 고칠 때 비워 두면 보내지 않는다', () => {
  const f = { ...emptyForm(), name: ' a ', user: ' u ', database: 'd', password: 'pw' };
  expect(toInput(f, 'p1', null)).toEqual({ projectId: 'p1', name: 'a', kind: 'postgres', host: 'localhost', port: 5432, database: 'd', user: 'u', ssl: false, agentAccess: 'ask', password: 'pw' });
  expect(toInput({ ...f, password: '' }, 'p1', null).password).toBe('');
  const edit = formOf(conn);
  expect(edit.password).toBe('');
  expect('password' in toInput(edit, 'p1', conn)).toBe(false);
  expect(toInput(edit, 'p1', conn).id).toBe('c1');
  expect(toInput({ ...edit, password: 'new' }, 'p1', conn).password).toBe('new');
  expect(toInput(edit, 'p1', conn, true).password).toBe('');
});

test('previewSql: 이름을 그 DB 의 방식으로 감싼다', () => {
  expect(previewSql('postgres', { schema: 'public', name: 'items', type: 'table' })).toBe('SELECT * FROM "items" LIMIT 100');
  expect(previewSql('postgres', { schema: 'log', name: 'a"b', type: 'table' })).toBe('SELECT * FROM "log"."a""b" LIMIT 100');
  expect(previewSql('mysql', { schema: 'shop', name: 'or`der', type: 'view' })).toBe('SELECT * FROM `or``der` LIMIT 100');
});

test('cellText', () => {
  expect([null, true, false, 0, 'x'].map(cellText)).toEqual(['NULL', 'true', 'false', '0', 'x']);
});

test('Oracle: 기본 포트, 서비스 이름이 있어야 한다, 미리 보기 문장은 ROWNUM 으로 줄인다', () => {
  expect(DEFAULT_PORT.oracle).toBe(1521);
  expect(KIND_LABEL.oracle).toBe('Oracle');
  const f = { ...emptyForm(), kind: 'oracle' as const, name: 'ora', user: 'reader', port: '1521' };
  expect(formProblem(f)).toContain('서비스 이름');
  expect(formProblem({ ...f, database: 'ORCLPDB1' })).toBeNull();
  expect(previewSql('oracle', { schema: 'READER', name: 'ITEMS', type: 'table' })).toBe('SELECT * FROM "READER"."ITEMS" WHERE ROWNUM <= 100');
  expect(previewSql('oracle', { schema: '', name: 'ITEMS', type: 'table' })).toBe('SELECT * FROM "ITEMS" WHERE ROWNUM <= 100');
});

test('MongoDB: 연결 문자열로 받는다. 미리 보기는 JSON 명령이다', () => {
  expect(DEFAULT_PORT.mongo).toBe(27017);
  const f = { ...emptyForm(), kind: 'mongo' as const, name: '몽고', host: '', user: '' };
  expect(formProblem(f)).toBeNull();
  expect(formProblem({ ...f, name: ' ' })).toContain('연결 이름');
  expect(formProblem({ ...f, password: 'postgres://x' })).toContain('mongodb://');
  expect(formProblem({ ...f, password: 'mongodb+srv://u:p@c.example.net/shop' })).toBeNull();
  expect(previewSql('mongo', { schema: '', name: 'items', type: 'table' })).toBe('{"collection":"items","op":"find","filter":{},"limit":100}');
});
