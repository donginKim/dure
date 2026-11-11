import { checkReadOnly } from '@core/dbquery/guard';
import { listColumns, listTables, runReadOnly, type DbTarget } from '@core/dbquery/drivers';

/**
 * 진짜 DB 로 조회 전용 강제를 확인한다. 시험용 DB 가 떠 있을 때만 돈다:
 *   DURE_TEST_PG=127.0.0.1:55432 DURE_TEST_MYSQL=127.0.0.1:53306 (사용자 dure/root, 비밀번호 durepw, 표 items 2500행, 뷰 cheap)
 */
const pgAt = process.env.DURE_TEST_PG;
const myAt = process.env.DURE_TEST_MYSQL;
const at = (s: string, o: Omit<DbTarget, 'host' | 'port'>): DbTarget => ({ host: s.split(':')[0]!, port: Number(s.split(':')[1]), ...o });
const LIM = { maxRows: 100, timeoutMs: 5000 };

const cases: [string, DbTarget | null][] = [
  ['postgres', pgAt ? at(pgAt, { kind: 'postgres', database: 'postgres', user: 'dure', password: 'durepw', ssl: false }) : null],
  ['mysql', myAt ? at(myAt, { kind: 'mysql', database: 'shop', user: 'root', password: 'durepw', ssl: false }) : null],
];

for (const [name, t] of cases) {
  describe.skipIf(!t)(`진짜 ${name}`, () => {
    const db = t!;
    const count = async (): Promise<number> => Number((await runReadOnly(db, 'select count(*) from items', [], LIM)).rows[0]![0]);

    test('조회하고, 값을 보낼 수 있는 모양으로 바꾸고, 상한에서 자른다', async () => {
      const r = await runReadOnly(db, 'select id, name, price, made, meta, raw from items order by id', [], LIM);
      expect(r.columns).toEqual(['id', 'name', 'price', 'made', 'meta', 'raw']);
      expect(r.rows.length).toBe(100);
      expect(r.truncated).toBe(true);
      expect(r.rows[0]!.slice(0, 2)).toEqual([1, 'item 1']);
      expect(String(r.rows[0]![2])).toBe('1.50');
      expect(typeof r.rows[0]![3]).toBe('string');
      expect(String(r.rows[0]![4]).replace(/\s/g, '')).toBe('{"n":1}');
      expect(r.rows[0]![5]).toBe('\\xdeadbeef');
      const few = await runReadOnly(db, 'select id from items where id <= 3 order by id', [], LIM);
      expect(few).toMatchObject({ columns: ['id'], rows: [[1], [2], [3]], truncated: false });
      const none = await runReadOnly(db, 'select id, name from items where id < 0', [], LIM);
      expect(none).toMatchObject({ columns: ['id', 'name'], rows: [], truncated: false });
    });

    test('표 목록과 칸 목록', async () => {
      const tables = await listTables(db);
      expect(tables.filter((x) => x.name === 'items' || x.name === 'cheap').map((x) => [x.name, x.type]).sort()).toEqual([['cheap', 'view'], ['items', 'table']]);
      const schema = tables.find((x) => x.name === 'items')!.schema;
      const cols = await listColumns(db, schema, 'items');
      expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'price', 'made', 'meta', 'raw']);
      expect(cols[0]!.key).toMatch(/PRI/);
      expect(cols[1]).toMatchObject({ name: 'name', nullable: false });
      expect(await listColumns(db, schema, "items'; drop table items; --")).toEqual([]);
    });

    test.each([
      ['insert into items(name) values (\'x\')'], ['update items set name = \'x\''], ['delete from items'], ['drop table items'],
      ['create table hacked(a int)'], ['truncate table items'],
    ])('검사기를 건너뛰고 직접 보내도 %j 는 DB 가 거절한다 (읽기 전용 트랜잭션)', async (sql) => {
      await expect(runReadOnly(db, sql, [], LIM)).rejects.toThrow(/read-only|READ ONLY/i);
      expect(await count()).toBe(2500);
    });

    test('검사기를 건너뛰고 직접 보내도 두 문장은 실행되지 않는다 (한 문장만 받는 방식)', async () => {
      await expect(runReadOnly(db, 'commit; delete from items', [], LIM)).rejects.toThrow();
      await expect(runReadOnly(db, 'select 1; delete from items', [], LIM)).rejects.toThrow();
      expect(await count()).toBe(2500);
    });

    test('데이터를 바꾸는 CTE 와 행 잠금도 DB 가 거절한다', async () => {
      if (db.kind === 'postgres') await expect(runReadOnly(db, 'with d as (delete from items returning id) select count(*) from d', [], LIM)).rejects.toThrow(/read-only/i);
      expect(() => checkReadOnly('select * from items for update', db.kind)).toThrow();
      expect(await count()).toBe(2500);
    });

    test('오래 걸리는 조회는 시간 제한에서 멈춘다', async () => {
      const slow = db.kind === 'postgres' ? 'select pg_sleep(20)' : 'select sleep(20)';
      const started = Date.now();
      const r = runReadOnly(db, slow, [], { maxRows: 10, timeoutMs: 1000 });
      // MySQL 의 sleep 은 시간 제한에 걸리면 오류 대신 1 을 돌려준다. 어느 쪽이든 20초를 다 기다리지 않아야 한다.
      await r.catch((e: Error) => expect(e.message).toMatch(/timeout|끝나지 않아|interrupted|exceeded/i));
      expect(Date.now() - started).toBeLessThan(8000);
    });

    test('비밀번호가 틀리면 접속하지 못하고, 오류 글에 비밀번호가 없다', async () => {
      const e = await runReadOnly({ ...db, password: 'wrong-secret-pw' }, 'select 1', [], LIM).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toContain('wrong-secret-pw');
    });
  });
}
