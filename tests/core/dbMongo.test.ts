import { checkReadOnly } from '@core/dbquery/guard';
import { listColumns, listTables, riskyPrivileges, runReadOnly, type DbTarget } from '@core/dbquery/drivers';
import { mongoCell, mongoUriParts, parseMongoCommand } from '@core/dbquery/mongo';

const cmd = (o: unknown): string => JSON.stringify(o);

describe('MongoDB 명령 검사', () => {
  test('조회 넷만 받는다: find, count, distinct, aggregate', () => {
    expect(parseMongoCommand(cmd({ collection: 'items', filter: { price: { $lt: 10 } }, projection: { name: 1 }, sort: { n: -1 }, limit: 5 }))).toMatchObject({ collection: 'items', op: 'find', limit: 5 });
    expect(parseMongoCommand(cmd({ collection: 'items', op: 'count' })).op).toBe('count');
    expect(parseMongoCommand(cmd({ collection: 'items', op: 'distinct', field: 'name' })).field).toBe('name');
    expect(parseMongoCommand(cmd({ collection: 'items', op: 'aggregate', pipeline: [{ $match: { n: 1 } }, { $group: { _id: '$tag', n: { $sum: 1 } } }] })).pipeline!.length).toBe(2);
    expect(checkReadOnly(` ${cmd({ collection: 'items' })} `, 'mongo')).toBe(cmd({ collection: 'items' }));
    for (const op of ['insert', 'insertOne', 'update', 'updateMany', 'delete', 'remove', 'drop', 'findAndModify', 'mapReduce', 'createIndex', 'command', 'eval']) {
      expect(() => parseMongoCommand(cmd({ collection: 'items', op })), op).toThrow('조회 전용입니다');
    }
    expect(() => parseMongoCommand('select * from items')).toThrow('JSON 으로 씁니다');
    expect(() => parseMongoCommand('[1]')).toThrow('JSON 객체 하나');
    expect(() => parseMongoCommand(cmd({ collection: 'items', update: { $set: { a: 1 } } }))).toThrow('모르는 항목');
    expect(() => parseMongoCommand(cmd({ op: 'find' }))).toThrow('collection');
    expect(() => parseMongoCommand(cmd({ collection: 'items', op: 'distinct' }))).toThrow('field');
    expect(() => parseMongoCommand(cmd({ collection: 'items', op: 'aggregate' }))).toThrow('pipeline');
    expect(() => parseMongoCommand(cmd({ collection: 'items', pipeline: [] }))).toThrow('aggregate 일 때만');
    expect(() => parseMongoCommand(cmd({ collection: 'items', limit: -1 }))).toThrow('정수');
    expect(() => parseMongoCommand('')).toThrow('비어 있습니다');
    expect(() => parseMongoCommand(cmd({ collection: 'items', filter: { a: 'x'.repeat(30000) } }))).toThrow('너무 깁니다');
  });

  test('쓰거나 서버에서 코드를 돌리는 것, 시스템 컬렉션을 막는다', () => {
    const agg = (...pipeline: unknown[]) => () => parseMongoCommand(cmd({ collection: 'items', op: 'aggregate', pipeline }));
    expect(agg({ $match: {} }, { $out: 'copy' })).toThrow('$out');
    expect(agg({ $merge: { into: 'copy' } })).toThrow('$merge');
    // 겹쳐 숨겨도 찾는다 ($lookup, $facet, $unionWith 안)
    expect(agg({ $lookup: { from: 'log', pipeline: [{ $out: 'x' }], as: 'j' } })).toThrow('$out');
    expect(agg({ $facet: { a: [{ $match: { $where: 'sleep(1000)' } }] } })).toThrow('$where');
    expect(agg({ $unionWith: { coll: 'log', pipeline: [{ $merge: 'x' }] } })).toThrow('$merge');
    expect(agg({ $addFields: { x: { $function: { body: 'function() { return 1 }', args: [], lang: 'js' } } } })).toThrow('$function');
    expect(agg({ $group: { _id: 1, x: { $accumulator: {} } } })).toThrow('$accumulator');
    expect(agg({ $currentOp: {} })).toThrow('$currentOp');
    expect(agg({ $changeStream: {} })).toThrow('$changeStream');
    expect(() => parseMongoCommand(cmd({ collection: 'items', filter: { $where: 'this.a == 1' } }))).toThrow('$where');
    expect(() => parseMongoCommand(cmd({ collection: 'items', filter: { a: { $code: 'x' } } }))).toThrow('$code');
    // 대소문자를 바꿔도 받지 않는다 (서버가 받지 않더라도 여기서 막는다)
    expect(agg({ $OUT: 'x' })).toThrow('$out');
    // 시스템 컬렉션
    expect(() => parseMongoCommand(cmd({ collection: 'system.users' }))).toThrow('시스템 컬렉션');
    expect(agg({ $lookup: { from: 'system.users', localField: 'a', foreignField: 'b', as: 'j' } })).toThrow('시스템 컬렉션');
    expect(agg({ $unionWith: 'ok' }, { $unionWith: { coll: 'System.js' } })).toThrow('시스템 컬렉션');
    expect(agg({ $lookup: { from: { db: 'admin', coll: 'x' }, as: 'j' } })).toThrow('다른 데이터베이스');
    // 받는 것: 다른 컬렉션을 읽기만 하는 단계, 글자열 값 안의 낱말
    expect(agg({ $lookup: { from: 'log', localField: 'a', foreignField: 'b', as: 'j' } }, { $unionWith: 'log' })).not.toThrow();
    expect(() => parseMongoCommand(cmd({ collection: 'items', filter: { name: '$out $where' } }))).not.toThrow();
  });

  test('연결 문자열에서 화면에 보일 것만 뽑는다. 값을 보낼 수 있는 모양으로 바꾼다', () => {
    expect(mongoUriParts('mongodb://reader:p%40ss@db.example.com:27018/shop?authSource=admin')).toEqual({ host: 'db.example.com', port: 27018, user: 'reader', database: 'shop', srv: false });
    expect(mongoUriParts('mongodb+srv://u:p@cluster0.abcde.mongodb.net/')).toEqual({ host: 'cluster0.abcde.mongodb.net', port: 27017, user: 'u', database: '', srv: true });
    expect(mongoUriParts('mongodb://h1:1,h2:2/db?replicaSet=rs')).toMatchObject({ host: 'h1', port: 1, user: '', database: 'db' });
    expect(() => mongoUriParts('postgres://x')).toThrow('mongodb://');
    expect(JSON.stringify(mongoUriParts('mongodb://reader:secret@h/db'))).not.toContain('secret');
    expect([mongoCell(null), mongoCell(1.5), mongoCell(true), mongoCell('a'), mongoCell(new Date(0)), mongoCell({ a: [1] }), mongoCell('x'.repeat(3000))]).toEqual([null, 1.5, true, 'a', '1970-01-01T00:00:00.000Z', '{"a":[1]}', `${'x'.repeat(2000)}… (3000자)`]);
  });
});

/**
 * 진짜 MongoDB. 시험용 DB 가 떠 있을 때만 돈다:
 *   DURE_TEST_MONGO=127.0.0.1:57017 (root/durepw: 관리자. reader/reader_pw: shop 을 읽기만. shop.items 2500건, 뷰 cheap)
 */
const at = process.env.DURE_TEST_MONGO;
describe.skipIf(!at)('진짜 mongo', () => {
  const target = (user: string, pw: string, auth: string): DbTarget => ({ kind: 'mongo', host: '', port: 0, database: 'shop', user, ssl: false, password: `mongodb://${user}:${pw}@${at}/shop?authSource=${auth}` });
  const ro = (): DbTarget => target('reader', 'reader_pw', 'shop');
  const root = (): DbTarget => target('root', 'durepw', 'admin');
  const LIM = { maxRows: 100, timeoutMs: 5000 };
  const run = (t: DbTarget, o: unknown, lim = LIM) => runReadOnly(t, checkReadOnly(cmd(o), 'mongo'), [], lim);
  const count = async (collection = 'items'): Promise<number> => Number((await run(root(), { collection, op: 'count' })).rows[0]![0]);

  test('조회하고, 값을 보낼 수 있는 모양으로 바꾸고, 상한에서 자른다', async () => {
    const r = await run(ro(), { collection: 'items', sort: { n: 1 } });
    expect(r.columns).toEqual(['_id', 'n', 'name', 'price', 'made', 'big', 'tags', 'meta', 'raw']);
    expect([r.rows.length, r.truncated]).toEqual([100, true]);
    const first = r.rows[0]!;
    expect(String(first[0])).toMatch(/^[0-9a-f]{24}$/);
    expect(first.slice(1, 4)).toEqual([1, 'item 1', '1.50']);
    expect(first[4]).toBe('2026-01-01T00:00:00.000Z');
    // 자릿수가 많은 정수가 깨지지 않는다. 겹친 값은 JSON 글자로. 이진 값은 줄여 보인다
    expect(first[5]).toBe('1234567890123456789');
    expect(first.slice(6)).toEqual(['["a","b"]', '{"k":0}', '\\x00ff10']);
    // 조건, 고른 칸, 순서, 개수
    expect((await run(ro(), { collection: 'items', filter: { n: { $lte: 3 } }, projection: { _id: 0, name: 1 }, sort: { n: -1 } })).rows).toEqual([['item 3'], ['item 2'], ['item 1']]);
    expect((await run(ro(), { collection: 'items', op: 'count', filter: { n: { $gt: 2000 } } })).rows).toEqual([[500]]);
    expect((await run(ro(), { collection: 'items', op: 'distinct', field: 'tags' })).rows).toEqual([['a'], ['b']]);
    const agg = await run(ro(), { collection: 'items', op: 'aggregate', pipeline: [{ $match: { n: { $lte: 10 } } }, { $group: { _id: null, total: { $sum: '$n' } } }] });
    expect(agg.rows).toEqual([[null, 55]]);
    // _id 로 찾는다 ({"$oid": ...})
    expect((await run(ro(), { collection: 'items', filter: { _id: { $oid: String(first[0]) } }, projection: { _id: 0, n: 1 } })).rows).toEqual([[1]]);
    // 뷰도 읽는다
    expect((await run(ro(), { collection: 'cheap', op: 'count' })).rows).toEqual([[6]]);
  });

  test('쓰기는 실행되지 않는다: 관리자 계정으로도 컬렉션에 쓰는 단계가 통하지 않는다', async () => {
    const before = await count();
    // 검사를 건너뛰고 드라이버에 직접 넣어도, 드라이버가 스스로 다시 검사한다
    await expect(runReadOnly(root(), cmd({ collection: 'items', op: 'aggregate', pipeline: [{ $out: 'stolen' }] }), [], LIM)).rejects.toThrow('$out');
    await expect(runReadOnly(root(), cmd({ collection: 'items', op: 'aggregate', pipeline: [{ $merge: { into: 'stolen' } }] }), [], LIM)).rejects.toThrow('$merge');
    await expect(runReadOnly(root(), cmd({ collection: 'items', op: 'deleteMany', filter: {} }), [], LIM)).rejects.toThrow('조회 전용입니다');
    await expect(runReadOnly(root(), 'db.items.drop()', [], LIM)).rejects.toThrow('JSON 으로 씁니다');
    expect(await count()).toBe(before);
    expect((await listTables(root())).map((t) => t.name)).not.toContain('stolen');
    // 읽기 전용 계정은 서버도 막는다
    expect(await riskyPrivileges(ro())).toEqual([]);
    expect((await riskyPrivileges(root())).join(' ')).toContain('읽기 전용 계정이 아닙니다');
  });

  test('시간 제한에서 멈춘다', async () => {
    const started = Date.now();
    // 서버에서 오래 걸리는 조회 (컬렉션을 자기 자신과 여러 번 잇는다)
    const slow = { collection: 'items', op: 'aggregate', pipeline: [{ $lookup: { from: 'items', pipeline: [{ $lookup: { from: 'items', pipeline: [], as: 'c' } }], as: 'b' } }, { $count: 'n' }] };
    await expect(run(ro(), slow, { maxRows: 10, timeoutMs: 1000 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(13_000);
    expect(await count()).toBe(2500);
  }, 30_000);

  test('컬렉션과 칸의 목록, 접속 오류', async () => {
    expect((await listTables(ro())).map((t) => [t.schema, t.name, t.type])).toEqual([['', 'cheap', 'view'], ['', 'items', 'table']]);
    const cols = await listColumns(ro(), '', 'items');
    expect(cols.map((c) => [c.name, c.type, c.nullable, c.key])).toEqual([
      ['_id', 'objectId', false, 'P'], ['n', 'number', false, 'U'], ['name', 'string', false, ''], ['price', 'decimal', false, ''], ['made', 'date', false, ''],
      ['big', 'number', false, ''], ['tags', 'array', false, ''], ['meta', 'object', false, ''], ['raw', 'binary', false, ''],
    ]);
    expect((await listColumns(ro(), '', 'cheap')).map((c) => c.name)).toContain('name');
    await expect(listColumns(ro(), '', 'system.users')).rejects.toThrow('올바르지 않습니다');
    // 틀린 비밀번호, 없는 서버는 오류로 돌아온다 (멈추지 않는다)
    await expect(run(target('reader', 'wrong', 'shop'), { collection: 'items', op: 'count' })).rejects.toThrow(/Authentication failed|bad auth/i);
    await expect(run({ ...ro(), password: 'mongodb://127.0.0.1:1/shop' }, { op: 'ping' })).rejects.toThrow();
    await expect(run({ ...ro(), password: '' }, { op: 'ping' })).rejects.toThrow('연결 문자열이 없습니다');
  }, 40_000);
});
