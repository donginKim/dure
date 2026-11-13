import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { DbTarget } from '@core/dbquery/drivers';
import type { DbConnectionInput, DbResult, Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let ws: Workspace;
let ran: { target: DbTarget; sql: string; maxRows: number }[];
let answer: (sql: string) => DbResult;
let risks: string[];

const secrets = { encrypt: (s: string) => `enc(${Buffer.from(s).toString('base64')})`, decrypt: (s: string) => Buffer.from(s.slice(4, -1), 'base64').toString() };
const input = (o: Partial<DbConnectionInput> = {}): DbConnectionInput => ({ projectId, name: '운영 DB', kind: 'postgres', host: 'db.internal', port: 5432, database: 'shop', user: 'reader', password: 'p@ss w0rd', ssl: false, agentAccess: 'ask', ...o });
const until = (cond: () => boolean, ms = 4000): Promise<void> => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = (): void => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : void setTimeout(tick, 15));
  tick();
});
async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}

async function boot(waitMs = 60): Promise<void> {
  ran = [];
  risks = [];
  answer = () => ({ columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], truncated: false, ms: 3 });
  core = await createCore({
    dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(),
    secrets, dbWaitMs: waitMs,
    dbRunner: {
      run: async (target, sql, _params, lim) => { ran.push({ target, sql, maxRows: lim.maxRows }); return answer(sql); },
      risks: async () => risks,
      tables: async () => [{ schema: 'public', name: 'items', type: 'table' }],
      columns: async (_t, schema, table) => [{ name: `${schema}.${table}.id`, type: 'integer', nullable: false, default: null, key: 'PRIMARY KEY' }],
    },
  });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
}
beforeEach(() => boot());
afterEach(async () => { await core.dispose(); });

describe('DB 연결', () => {
  test('등록하면 비밀번호는 암호화해 두고, 목록에는 비밀번호가 없다', () => {
    const c = core.dbs.save(input());
    expect(c).toMatchObject({ name: '운영 DB', kind: 'postgres', host: 'db.internal', port: 5432, database: 'shop', user: 'reader', ssl: false, agentAccess: 'ask', hasPassword: true });
    expect(JSON.stringify(core.dbs.list(projectId))).not.toContain('p@ss');
    const raw = JSON.stringify(core.dbs['d'].db.prepare('SELECT * FROM db_connections').all());
    expect(raw).not.toContain('p@ss w0rd');
    expect(raw).toContain('enc(');
  });

  test('고칠 때 비밀번호를 주지 않으면 그대로 두고, 빈 글이면 지운다', async () => {
    const c = core.dbs.save(input());
    core.dbs.save({ ...input({ host: 'new.internal' }), id: c.id, password: undefined });
    expect((await core.dbs.test(c.id)).warnings).toEqual([]);
    expect(ran.at(-1)!.target).toMatchObject({ host: 'new.internal', password: 'p@ss w0rd' });
    expect(core.dbs.save({ ...input(), id: c.id, password: '' }).hasPassword).toBe(false);
    await core.dbs.test(c.id);
    expect(ran.at(-1)!.target.password).toBe('');
  });

  test('잘못된 입력과 겹치는 이름을 거절한다. 비밀번호를 저장할 방법이 없으면 저장하지 않는다', async () => {
    core.dbs.save(input());
    expect(() => core.dbs.save(input())).toThrow('이미 있는 연결 이름');
    expect(() => core.dbs.save(input({ name: ' ' }))).toThrow('연결 이름');
    expect(() => core.dbs.save(input({ name: 'x', kind: 'sqlite' as never }))).toThrow('지원하지 않는');
    // Oracle 은 서비스 이름이 있어야 한다
    expect(() => core.dbs.save(input({ name: 'x', kind: 'oracle', database: '' }))).toThrow('서비스 이름');
    expect(() => core.dbs.save(input({ name: 'x', host: '' }))).toThrow('호스트');
    expect(() => core.dbs.save(input({ name: 'x', port: 70000 }))).toThrow('포트');
    expect(() => core.dbs.save(input({ name: 'x', user: '' }))).toThrow('사용자 이름');
    expect(() => core.dbs.save(input({ name: 'x', database: '' }))).toThrow('데이터베이스 이름');
    expect(() => core.dbs.save(input({ name: 'x', agentAccess: 'all' as never }))).toThrow('사용 방식');
    expect(core.dbs.save(input({ name: 'my', kind: 'mysql', database: '', port: 3306 })).kind).toBe('mysql');
    await core.dispose();
    core = await createCore({ dataDir: join(tempDir(), 'd2'), worktreeRoot: join(tempDir(), 'wt2'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
    const p2 = core.projects.create('p2').id;
    expect(() => core.dbs.save(input({ projectId: p2 }))).toThrow('안전하게 저장할 수 없습니다');
    expect(core.dbs.list(p2)).toEqual([]);
    expect(core.dbs.save(input({ projectId: p2, password: '' })).hasPassword).toBe(false);
  });

  test('사용자의 조회는 조회 전용 검사를 거치고 1000행까지 받는다', async () => {
    const c = core.dbs.save(input());
    await expect(core.dbs.query(c.id, 'select * from items;')).resolves.toMatchObject({ columns: ['id', 'name'] });
    expect(ran.at(-1)).toMatchObject({ sql: 'select * from items', maxRows: 1000 });
    expect(() => core.dbs.query(c.id, 'delete from items')).toThrow('조회 전용입니다');
    expect(() => core.dbs.query(c.id, 'select 1; drop table items')).toThrow('하나만');
    expect(ran.length).toBe(1);
  });

  test('프로젝트를 지우면 연결도 지워진다', async () => {
    core.dbs.save(input());
    await core.removeProject(projectId);
    expect(core.dbs['d'].db.prepare('SELECT count(*) AS n FROM db_connections').get()).toEqual({ n: 0 });
  });
});

describe('에이전트의 DB 도구', () => {
  test('db_list 는 이름과 종류만 준다. 접속 정보와 꺼 둔 연결은 주지 않는다', async () => {
    core.dbs.save(input());
    core.dbs.save(input({ name: '로컬', agentAccess: 'auto', host: 'localhost' }));
    core.dbs.save(input({ name: '비밀', agentAccess: 'off', host: 'secret.internal' }));
    const text = await call(ws.id, 'db_list');
    expect(text).toContain('운영 DB');
    expect(text).toContain('로컬');
    expect(text).not.toContain('비밀');
    for (const leak of ['db.internal', 'localhost', 'secret.internal', 'reader', 'p@ss', '5432', 'enc(', 'shop']) expect(text).not.toContain(leak);
  });

  test('바로 조회하는 연결: 검사를 거쳐 100행까지 바로 돌려준다', async () => {
    core.dbs.save(input({ name: '로컬', agentAccess: 'auto' }));
    const text = await call(ws.id, 'db_query', { connection: '로컬', sql: 'select id, name from items' });
    expect(text).toContain('\\"rows\\":[[1,\\"a\\"],[2,\\"b\\"]]');
    expect(ran.at(-1)).toMatchObject({ sql: 'select id, name from items', maxRows: 100 });
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: 'update items set name = 1' })).toContain('조회 전용입니다');
    expect(await call(ws.id, 'db_query', { connection: '없음', sql: 'select 1' })).toContain('라는 DB 연결이 없다');
    expect(ran.length).toBe(1);
    expect(core.dbs.pending(projectId)).toEqual([]);
  });

  test('결과가 크면 줄여서 돌려주고 잘렸다고 알린다', async () => {
    core.dbs.save(input({ name: '로컬', agentAccess: 'auto' }));
    answer = () => ({ columns: ['t'], rows: Array.from({ length: 100 }, () => ['x'.repeat(2000)]), truncated: false, ms: 1 });
    const text = await call(ws.id, 'db_query', { connection: '로컬', sql: 'select t from big' });
    expect(text.length).toBeLessThan(90_000);
    expect(text).toContain('결과가 잘렸다');
  });

  test('승인을 받는 연결: 사용자가 승인하기 전에는 실행되지 않고, 승인하면 결과가 돌아온다', async () => {
    await core.dispose(); await boot(3000);
    core.dbs.save(input());
    const asked = call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select id, name from items' });
    await until(() => core.dbs.pending(projectId).length === 1);
    expect(ran).toEqual([]);
    const req = core.dbs.pending(projectId)[0]!;
    expect(req).toMatchObject({ workspaceId: ws.id, connectionName: '운영 DB', sql: 'select id, name from items', status: 'pending' });
    await core.dbs.decide(req.id, true);
    expect(await asked).toContain('\\"rows\\":[[1,\\"a\\"],[2,\\"b\\"]]');
    expect(ran.length).toBe(1);
    expect(core.dbs.pending(projectId)).toEqual([]);
    await expect(core.dbs.decide(req.id, true)).rejects.toThrow('결정을 기다리는 조회 요청이 아닙니다');
    expect(ran.length).toBe(1);
    // 표 목록과 스키마는 승인 없이 본다
    expect(await call(ws.id, 'db_tables', { connection: '운영 DB' })).toContain('items');
    expect(await call(ws.id, 'db_columns', { connection: '운영 DB', table: 'items' })).toContain('public.items.id');
  });

  test('거절하면 실행되지 않고 에이전트는 거절을 받는다. 조회가 아닌 문장은 사용자에게 올라가지도 않는다', async () => {
    await core.dispose(); await boot(3000);
    core.dbs.save(input());
    expect(await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'delete from items' })).toContain('조회 전용입니다');
    expect(core.dbs.pending(projectId)).toEqual([]);
    const asked = call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select * from users' });
    await until(() => core.dbs.pending(projectId).length === 1);
    await core.dbs.decide(core.dbs.pending(projectId)[0]!.id, false);
    expect(await asked).toContain('사용자가 이 조회를 거절했다');
    expect(ran).toEqual([]);
  });

  test('승인이 늦으면 "기다리는 중" 으로 돌아가고, 결정되면 두레가 알리고 db_result 로 결과를 받는다', async () => {
    core.dbs.save(input());
    const text = await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select id from items' });
    expect(text).toContain('승인을 기다리는 중');
    const req = core.dbs.pending(projectId)[0]!;
    expect(text).toContain(req.id);
    expect(await call(ws.id, 'db_result', { request_id: req.id })).toContain('승인을 기다리는 중');
    await core.dbs.decide(req.id, true);
    const note = core.messages.undelivered(ws.id).map((m) => m.body).join('\n');
    expect(note).toContain('사용자가 DB 조회를 승인했고');
    expect(note).toContain(req.id);
    expect(note).not.toContain('"a"');
    expect(await call(ws.id, 'db_result', { request_id: req.id })).toContain('\\"rows\\":[[1,\\"a\\"],[2,\\"b\\"]]');
    // 다른 워크스페이스는 그 결과를 받을 수 없다
    const repo2 = await core.addRepo(projectId, makeRepo('other'));
    const other = await core.service.create({ projectId, repoId: repo2.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    expect(await call(other.id, 'db_result', { request_id: req.id })).toContain('그런 조회 요청이 없다');
  });

  test('"앞으로 묻지 않기" 로 승인하면 그 연결은 바로 조회로 바뀐다', async () => {
    const c = core.dbs.save(input());
    await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 1' });
    await core.dbs.decide(core.dbs.pending(projectId)[0]!.id, true, { always: true });
    expect(core.dbs.get(c.id)!.agentAccess).toBe('auto');
    expect(await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 2' })).toContain('rows');
    expect(core.dbs.pending(projectId)).toEqual([]);
  });

  test('꺼 둔 연결, 기다리는 요청이 너무 많을 때, 실행 실패, 연결 삭제', async () => {
    core.dbs.save(input({ name: '비밀', agentAccess: 'off' }));
    expect(await call(ws.id, 'db_query', { connection: '비밀', sql: 'select 1' })).toContain('에이전트가 쓰지 못하게');
    expect(await call(ws.id, 'db_tables', { connection: '비밀' })).toContain('에이전트가 쓰지 못하게');
    const c = core.dbs.save(input());
    for (let i = 0; i < 3; i++) expect(await call(ws.id, 'db_query', { connection: '운영 DB', sql: `select ${i}` })).toContain('승인을 기다리는 중');
    expect(await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 9' })).toContain('이미 3개다');
    const [a, b] = core.dbs.pending(projectId);
    answer = () => { throw new Error('relation "nope" does not exist'); };
    await core.dbs.decide(a!.id, true);
    expect(await call(ws.id, 'db_result', { request_id: a!.id })).toMatch(/조회가 실패했다: relation .*nope.* does not exist/);
    core.dbs.remove(c.id);
    expect(core.dbs.pending(projectId)).toEqual([]);
    expect(await call(ws.id, 'db_result', { request_id: b!.id })).toContain('거절했다');
  });

  test('완료된 프로젝트에서는 조회할 수 없다', async () => {
    const c = core.dbs.save(input({ agentAccess: 'auto' }));
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
    expect(() => core.dbs.forAgent(projectId, '운영 DB')).toThrow('완료된 프로젝트');
    expect(() => core.dbs.save({ ...input(), id: c.id })).toThrow('완료된 프로젝트');
  });

  test('읽기 전용 계정이 아니면 "바로 조회" 여도 승인을 받고, 경고가 요청에 실린다', async () => {
    risks = ['슈퍼유저입니다'];
    const c = core.dbs.save(input({ name: '로컬', agentAccess: 'auto' }));
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: 'select 1' })).toContain('승인을 기다리는 중');
    expect(ran).toEqual([]);
    expect(core.dbs.pending(projectId)[0]!.warnings).toEqual(['슈퍼유저입니다']);
    expect(core.dbs.get(c.id)!.warnings).toEqual(['슈퍼유저입니다']);
    expect(await call(ws.id, 'db_list')).toContain('승인을 받는다');
    expect((await core.dbs.test(c.id)).warnings).toEqual(['슈퍼유저입니다']);
  });

  test('요청한 뒤에 연결이 바뀌거나 꺼지면 승인해도 실행되지 않는다', async () => {
    const c = core.dbs.save(input());
    await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 1' });
    core.dbs.save({ ...input({ host: 'other.internal' }), id: c.id, password: undefined });
    await expect(core.dbs.decide(core.dbs.pending(projectId)[0]!.id, true)).rejects.toThrow('접속 정보가 바뀌었다');
    await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 2' });
    const second = core.dbs.pending(projectId)[0]!.id;
    core.dbs.save({ ...input({ host: 'other.internal', agentAccess: 'off' }), id: c.id, password: undefined });
    await expect(core.dbs.decide(second, true)).rejects.toThrow('쓰지 못하게 바꿨다');
    expect(ran).toEqual([]);
    expect(await call(ws.id, 'db_result', { request_id: second })).toContain('거절했다');
  });

  test('완료된 프로젝트의 기다리던 요청은 사라지고 실행되지 않는다', async () => {
    core.dbs.save(input());
    await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 1' });
    const id = core.dbs.pending(projectId)[0]!.id;
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
    expect(core.dbs.pending(projectId)).toEqual([]);
    await expect(core.dbs.decide(id, true)).rejects.toThrow('결정을 기다리는 조회 요청이 아닙니다');
    expect(ran).toEqual([]);
  });

  test('접속 오류의 호스트·사용자는 에이전트에게 가지 않는다. 문장의 오류는 그대로 간다', async () => {
    core.dbs.save(input({ name: '로컬', agentAccess: 'auto' }));
    for (const m of ['connect ECONNREFUSED 10.1.2.3:5432', 'password authentication failed for user "reader"', "Access denied for user 'root'@'172.17.0.1'", 'getaddrinfo ENOTFOUND db.internal']) {
      answer = () => { throw new Error(m); };
      const text = await call(ws.id, 'db_query', { connection: '로컬', sql: 'select 1' });
      expect(text).toContain('DB 에 접속하지 못했다');
      for (const leak of ['10.1.2.3', 'reader', 'root', '172.17', 'db.internal']) expect(text).not.toContain(leak);
    }
    answer = () => { throw new Error('column "nope" does not exist'); };
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: 'select nope from items' })).toContain('does not exist');
  });

  test('한 연결에서 동시에 도는 조회는 3개까지다. 너무 긴 문장은 받지 않는다', async () => {
    core.dbs.save(input({ name: '로컬', agentAccess: 'auto' }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const real = core.dbs['d'].runner!.run;
    core.dbs['d'].runner!.run = async (...a) => { await gate; return real(...a); };
    const going = [1, 2, 3].map((i) => call(ws.id, 'db_query', { connection: '로컬', sql: `select ${i}` }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: 'select 4' })).toContain('이미 3개 돌고 있다');
    release();
    for (const g of going) expect(await g).toContain('rows');
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: 'select 5' })).toContain('rows');
    expect(await call(ws.id, 'db_query', { connection: '로컬', sql: `select '${'x'.repeat(4000)}'` })).toContain('문장이 너무 길다');
  });

  test('승인돼 실행 중일 때 db_result 는 실패가 아니라 기다리는 중이다. 실패한 승인은 "앞으로 묻지 않기" 를 반영하지 않는다', async () => {
    const c = core.dbs.save(input());
    await call(ws.id, 'db_query', { connection: '운영 DB', sql: 'select 1' });
    const id = core.dbs.pending(projectId)[0]!.id;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    answer = () => { throw new Error('syntax error'); };
    const real = core.dbs['d'].runner!.run;
    core.dbs['d'].runner!.run = async (...a) => { await gate; return real(...a); };
    const deciding = core.dbs.decide(id, true, { always: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(await call(ws.id, 'db_result', { request_id: id })).toContain('승인을 기다리는 중');
    release(); await deciding;
    expect(await call(ws.id, 'db_result', { request_id: id })).toContain('조회가 실패했다: syntax error');
    expect(core.dbs.get(c.id)!.agentAccess).toBe('ask');
  });
});
