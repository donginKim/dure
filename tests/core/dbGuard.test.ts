import { checkReadOnly, skeleton } from '@core/dbquery/guard';

const ok = (sql: string, kind: 'postgres' | 'mysql' = 'postgres') => checkReadOnly(sql, kind);

test('조회 계열 문장은 받고, 끝의 ; 는 뗀다', () => {
  expect(ok('select * from items;  ')).toBe('select * from items');
  expect(ok('  WITH x AS (SELECT 1) SELECT * FROM x')).toContain('WITH x');
  expect(ok('(select 1) union (select 2)')).toContain('union');
  expect(ok('SHOW server_version')).toBe('SHOW server_version');
  expect(ok('explain select 1')).toBe('explain select 1');
  expect(ok('TABLE items')).toBe('TABLE items');
  expect(ok('DESCRIBE items', 'mysql')).toBe('DESCRIBE items');
  expect(ok('SHOW TABLES', 'mysql')).toBe('SHOW TABLES');
});

test.each([
  ['insert into items values (1)'], ['update items set name = 1'], ['delete from items'], ['drop table items'], ['truncate items'],
  ['create table x(a int)'], ['alter table items add c int'], ['grant all on items to x'], ['copy items to program \'x\''],
  ['call do_it()'], ['do $$ begin delete from items; end $$'], ['set default_transaction_read_only = off'], ['commit'], ['begin'],
  ['vacuum'], ['lock table items'], ['describe items'],
])('조회가 아닌 문장 %j 는 거절한다', (sql) => {
  expect(() => ok(sql)).toThrow('조회 전용입니다');
});

test('문장이 둘 이상이면 거절한다. 글자열과 주석 안의 ; 는 문장 구분이 아니다', () => {
  expect(() => ok('select 1; delete from items')).toThrow('하나만');
  expect(() => ok('commit; delete from items')).toThrow();
  expect(() => ok('select 1;;')).toThrow('하나만');
  expect(ok("select ';' as a, \"b;c\" from t -- ; 주석\n")).toContain("';'");
  expect(ok('select 1 /* ; */')).toContain('select 1');
  expect(ok('select $$ a; b $$, $x$ ; $x$')).toContain('$$');
  expect(ok("select 'it''s; ok'")).toContain('it');
  expect(ok('select `a;b` from t # ; 주석', 'mysql')).toContain('`a;b`');
  expect(ok("select 'a\\'; b' from t", 'mysql')).toContain('from t');
});

test('글자열로 숨긴 것처럼 보이게 해도 둘째 문장을 잡는다', () => {
  // PostgreSQL 에서는 역슬래시가 따옴표를 벗어나지 않는다: 글자열은 'a\' 에서 끝나고 뒤가 문장이다.
  expect(() => ok("select 'a\\'; delete from items; --'")).toThrow('하나만');
  // MySQL 의 # 은 주석이지만 PostgreSQL 에서는 아니다.
  expect(() => ok('select 1 # x\n; delete from items')).toThrow('하나만');
  // PostgreSQL 은 주석이 겹친다: 끝까지가 주석 하나다. MySQL 은 첫 */ 에서 끝나 뒤가 문장이다.
  expect(ok('select 1 /* /* */ ; delete from items -- */')).toContain('select 1');
  expect(() => ok('select 1 /* /* */ ; delete from items -- */', 'mysql')).toThrow('하나만');
});

test('닫히지 않은 따옴표와 주석, 빈 문장, 너무 긴 문장, 실행되는 주석을 거절한다', () => {
  expect(() => ok("select 'abc")).toThrow('닫히지 않았습니다');
  expect(() => ok('select 1 /* abc')).toThrow('닫히지 않았습니다');
  expect(() => ok('select $a$ x')).toThrow('닫히지 않았습니다');
  expect(() => ok('  ;  ')).toThrow('비어 있습니다');
  expect(() => ok('-- 주석만')).toThrow('비어 있습니다');
  expect(() => ok(`select '${'x'.repeat(20001)}'`)).toThrow('너무 깁니다');
  expect(() => ok('select 1 /*! into outfile "/tmp/x" */', 'mysql')).toThrow('실행되는 주석');
  expect(() => ok('select 1 /*M!100100 x */', 'mysql')).toThrow('실행되는 주석');
  expect(() => checkReadOnly(undefined as never, 'postgres')).toThrow('비어 있습니다');
});

test('읽기 전용 트랜잭션으로 막히지 않는 것을 거절한다: 실제로 실행하는 EXPLAIN, 파일 쓰기, 행 잠금', () => {
  expect(() => ok('explain analyze delete from items')).toThrow('EXPLAIN ANALYZE');
  expect(() => ok('EXPLAIN (ANALYZE, BUFFERS) select 1')).toThrow('EXPLAIN ANALYZE');
  expect(() => ok("select * from items into outfile '/tmp/x'", 'mysql')).toThrow('outfile');
  expect(() => ok("select 1 INTO\n DUMPFILE '/tmp/x'", 'mysql')).toThrow('dumpfile');
  expect(() => ok('select * from items for update')).toThrow('잠그는');
  expect(() => ok('select * from items FOR  SHARE')).toThrow('잠그는');
  expect(() => ok('select * from items lock in share mode', 'mysql')).toThrow('잠그는');
  // 글자열 안의 같은 낱말은 괜찮다
  expect(ok("select 'for update' as note, 'analyze' from items")).toContain('for update');
});

test('skeleton: 글자열과 주석을 지운 뼈대', () => {
  expect(skeleton("select 'a;b', x -- c\nfrom t", 'postgres')!.replace(/\s+/g, ' ')).toBe("select '' , x from t");
});

test('MySQL 의 -- 는 뒤에 공백이 있어야 주석이다: --1 뒤에 숨긴 것을 잡는다', () => {
  expect(() => ok("select 'x', 5 --1 into outfile '/var/lib/mysql-files/x.txt'", 'mysql')).toThrow('outfile');
  expect(() => ok("select 'x', 5 --1 into dumpfile '/tmp/x'", 'mysql')).toThrow('dumpfile');
  expect(() => ok('select * from items where id = 5 --1 lock in share mode', 'mysql')).toThrow('잠그는');
  expect(() => ok('select 5 --1; delete from items', 'mysql')).toThrow('하나만');
  expect(ok('select 5 -- 주석 ; x', 'mysql')).toContain('select 5');
  expect(ok('select 5 --', 'mysql')).toContain('select 5');
  // PostgreSQL 에서는 --1 도 주석이다
  expect(ok('select 5 --1; delete from items')).toContain('select 5');
});

test('서버 모드에 따라 해석이 달라지는 글자열로 숨겨도 잡는다 (낱말은 글자열 안이어도 받지 않는다)', () => {
  expect(() => ok("select '\\' into outfile '/tmp/x' -- '", 'mysql')).toThrow('outfile');
  expect(() => ok('select 1 as "\\" into outfile \'/tmp/x\' -- "', 'mysql')).toThrow('outfile');
  expect(() => ok("select load_file('/etc/passwd')", 'mysql')).toThrow('load_file');
  expect(() => ok('select /*+ MAX_EXECUTION_TIME(3600000) */ 1', 'mysql')).toThrow('힌트');
  expect(() => ok('select lock/**/in/**/share/**/mode', 'mysql')).toThrow('잠그는');
});

test.each([
  ["select pg_read_file('/etc/passwd')"], ["select pg_ls_dir('.')"], ["select lo_export(1, '/tmp/x')"], ["select dblink_exec('host=x', 'delete from t')"],
  ['select pg_terminate_backend(1)'], ['select pg_reload_conf()'], ["select pg_create_physical_replication_slot('x')"], ['select usename, passwd from pg_shadow'],
  ["select set_config('statement_timeout', '0', false)"], ['select "pg_read_file"(\'/etc/passwd\')'], ['select PG_Switch_Wal()'], ['select pg_advisory_lock(1)'],
])('PostgreSQL: 서버 파일, 다른 세션, 설정에 닿는 %j 는 거절한다', (sql) => {
  expect(() => ok(sql)).toThrow('실행할 수 없습니다');
});

test('EXPLAIN ANALYSE (영국식 철자) 도 거절한다', () => {
  expect(() => ok('explain analyse select 1')).toThrow('EXPLAIN ANALYZE');
});
