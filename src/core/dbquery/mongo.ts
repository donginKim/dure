import { BSON, MongoClient, type Document } from 'mongodb';
import type { DbCell, DbColumn, DbResult, DbTable } from '@shared/types';

/**
 * MongoDB 조회. SQL 이 아니라 JSON 으로 된 명령 하나를 받는다:
 *   { "collection": "items", "op": "find", "filter": { "price": { "$lt": 10 } }, "projection": { "name": 1 }, "sort": { "n": -1 }, "limit": 50 }
 *   { "collection": "items", "op": "count", "filter": {} }
 *   { "collection": "items", "op": "distinct", "field": "name", "filter": {} }
 *   { "collection": "items", "op": "aggregate", "pipeline": [ { "$group": { "_id": "$tag", "n": { "$sum": 1 } } } ] }
 *
 * 조회 전용 강제: MongoDB 에는 읽기 전용 트랜잭션이 없다. 그래서 두레가 부르는 동작을 조회 넷으로 정해 두고
 * (find, count, distinct, aggregate), 그 안에서 쓰거나 서버에서 코드를 돌리는 것을 거른다:
 *   $out, $merge (컬렉션에 쓴다), $where, $function, $accumulator, $code (서버에서 JS 를 돌린다), 그 밖에 서버의 상태를 보는 단계.
 * 검사는 실행하는 쪽(runMongo)이 스스로 다시 한다: 검사를 건너뛰고 실행할 길이 없다.
 */

const { EJSON } = BSON;

export interface MongoCommand {
  collection: string;
  op: 'find' | 'count' | 'distinct' | 'aggregate' | 'ping';
  filter?: Document; projection?: Document; sort?: Document; skip?: number; limit?: number;
  field?: string; pipeline?: Document[];
}

const OPS = ['find', 'count', 'distinct', 'aggregate', 'ping'];
const KEYS = ['collection', 'op', 'filter', 'projection', 'sort', 'skip', 'limit', 'field', 'pipeline'];
/** 어디에 있든 받지 않는 연산자 */
const BANNED = ['$out', '$merge', '$where', '$function', '$accumulator', '$code', '$changeStream', '$changeStreamSplitLargeEvent', '$currentOp', '$listSessions', '$listLocalSessions',
  '$listSearchIndexes', '$queryStats', '$querySettings', '$planCacheStats', '$shardedDataDistribution'];
const MAX_TEXT = 20_000;
const MAX_DEPTH = 40;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 안쪽까지 훑어 받지 않는 연산자와 시스템 컬렉션을 찾는다. */
function scan(v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('명령이 너무 깊게 겹쳐 있습니다.');
  if (Array.isArray(v)) { for (const x of v) scan(x, depth + 1); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    const hit = BANNED.find((b) => b.toLowerCase() === k.toLowerCase());
    if (hit) throw new Error(`"${hit}" 은(는) 쓸 수 없습니다 (컬렉션에 쓰거나, 서버에서 코드를 돌리거나, 서버의 상태에 닿습니다).`);
    // 다른 컬렉션을 끌어오는 단계($lookup, $unionWith, $graphLookup)로 시스템 컬렉션을 읽지 못하게 한다.
    if ((k === 'from' || k === 'coll') && typeof x === 'string' && /^system\./i.test(x.trim())) throw new Error('시스템 컬렉션은 조회할 수 없습니다.');
    if ((k === 'from' || k === 'coll') && isObj(x)) throw new Error('다른 데이터베이스의 컬렉션은 끌어올 수 없습니다.');
    scan(x, depth + 1);
  }
}

/** 명령을 읽고 조회 전용으로 받을 수 있는지 본다. 안 되면 이유를 던진다. */
export function parseMongoCommand(text: string): MongoCommand {
  if (typeof text !== 'string' || !text.trim()) throw new Error('조회할 명령이 비어 있습니다.');
  if (text.length > MAX_TEXT) throw new Error(`명령이 너무 깁니다 (${MAX_TEXT}자까지).`);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('MongoDB 조회는 JSON 으로 씁니다. 예: {"collection":"items","op":"find","filter":{},"limit":100}'); }
  if (!isObj(raw)) throw new Error('명령은 JSON 객체 하나여야 합니다.');
  const extra = Object.keys(raw).find((k) => !KEYS.includes(k));
  if (extra) throw new Error(`모르는 항목입니다: "${extra}". 쓸 수 있는 것: ${KEYS.join(', ')}`);
  const op = String(raw.op ?? 'find');
  if (!OPS.includes(op)) throw new Error(`조회 전용입니다. op 는 find, count, distinct, aggregate 만 됩니다 (받은 것: ${op}).`);
  if (op === 'ping') return { collection: '', op: 'ping' };
  const collection = typeof raw.collection === 'string' ? raw.collection.trim() : '';
  if (!collection) throw new Error('collection 을 적으세요.');
  if (collection.length > 200 || /[\0$]/.test(collection)) throw new Error('컬렉션 이름이 올바르지 않습니다.');
  if (/^system\./i.test(collection)) throw new Error('시스템 컬렉션은 조회할 수 없습니다.');
  const obj = (k: string): Document | undefined => {
    if (raw[k] === undefined || raw[k] === null) return undefined;
    if (!isObj(raw[k])) throw new Error(`${k} 는 JSON 객체여야 합니다.`);
    return raw[k] as Document;
  };
  const num = (k: string): number | undefined => {
    if (raw[k] === undefined || raw[k] === null) return undefined;
    const n = Number(raw[k]);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw new Error(`${k} 는 0 이상의 정수여야 합니다.`);
    return n;
  };
  const cmd: MongoCommand = { collection, op: op as MongoCommand['op'], filter: obj('filter'), projection: obj('projection'), sort: obj('sort'), skip: num('skip'), limit: num('limit') };
  if (op === 'distinct') {
    if (typeof raw.field !== 'string' || !raw.field.trim() || raw.field.includes('\0') || raw.field.startsWith('$')) throw new Error('distinct 에는 field (칸 이름) 를 적으세요.');
    cmd.field = raw.field.trim();
  }
  if (op === 'aggregate') {
    if (!Array.isArray(raw.pipeline) || raw.pipeline.some((s) => !isObj(s))) throw new Error('aggregate 에는 pipeline (단계의 배열) 을 적으세요.');
    if (raw.pipeline.length > 50) throw new Error('pipeline 의 단계가 너무 많습니다 (50개까지).');
    cmd.pipeline = raw.pipeline as Document[];
  } else if (raw.pipeline !== undefined) throw new Error('pipeline 은 op 가 aggregate 일 때만 씁니다.');
  scan([cmd.filter, cmd.projection, cmd.sort, cmd.pipeline], 0);
  return cmd;
}

/** 화면과 에이전트가 넣을 본보기 명령. */
export const mongoExample = (collection: string): string => JSON.stringify({ collection, op: 'find', filter: {}, limit: 100 });

export interface MongoTarget { uri: string; database: string }
export interface MongoLimits { maxRows: number; timeoutMs: number; maxBytes?: number }
const CONNECT_MS = 8000;
const MAX_CELL = 2000;
const MAX_COLUMNS = 200;
const DEFAULT_BYTES = 64 * 1024 * 1024;

const cut = (s: string): string => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}… (${s.length}자)` : s);

/** 문서의 값 하나를 화면과 에이전트에게 보낼 수 있는 값으로. */
export function mongoCell(v: unknown): DbCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return cut(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
  const type = (v as { _bsontype?: string })._bsontype;
  if (type === 'ObjectId') return String(v);
  if (type === 'Long' || type === 'Decimal128' || type === 'Timestamp') { const s = String(v); return type === 'Long' && /^-?\d{1,15}$/.test(s) ? Number(s) : s; }
  if (type === 'Int32' || type === 'Double') return Number((v as { valueOf(): number }).valueOf());
  if (type === 'Binary') {
    const b = Buffer.from((v as { buffer: Uint8Array }).buffer);
    return `\\x${b.subarray(0, 32).toString('hex')}${b.length > 32 ? `… (${b.length}바이트)` : ''}`;
  }
  try { return cut(EJSON.stringify(v, { relaxed: true })); } catch { return cut(String(v)); }
}

const fail = (e: unknown): Error => new Error(String((e as { message?: string })?.message ?? e).replace(/\s+/g, ' ').slice(0, 500) || 'DB 오류');

/** 접속해서 일을 하고 닫는다. 전체 시간 제한을 넘으면 연결을 끊는다. */
async function withDb<T>(t: MongoTarget, timeoutMs: number, work: (db: ReturnType<MongoClient['db']>) => Promise<T>): Promise<T> {
  if (!/^mongodb(\+srv)?:\/\//.test(t.uri)) throw new Error('연결 문자열이 없습니다. 연결을 고쳐 다시 적으세요.');
  const client = new MongoClient(t.uri, {
    serverSelectionTimeoutMS: CONNECT_MS, connectTimeoutMS: CONNECT_MS, socketTimeoutMS: timeoutMs + 5000,
    maxPoolSize: 1, appName: 'dure (read-only)',
    // 64비트 정수를 숫자로 바꾸면 자릿수가 깨진다. 글자로 받는다.
    promoteLongs: false,
  });
  let abort: (e: Error) => void = () => undefined;
  const overall = new Promise<never>((_, reject) => { abort = reject; });
  overall.catch(() => undefined);
  const whole = setTimeout(() => { void client.close(true).catch(() => undefined); abort(new Error(`조회가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`)); }, CONNECT_MS + timeoutMs + 3000);
  try {
    await Promise.race([client.connect(), overall]);
    return await Promise.race([work(client.db(t.database)), overall]);
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(whole);
    void client.close(true).catch(() => undefined);
  }
}

/** 명령 하나를 조회 전용으로 실행한다. 글로 받아 스스로 검사한다. */
export async function runMongo(t: MongoTarget, text: string, lim: MongoLimits): Promise<DbResult> {
  const cmd = parseMongoCommand(text);
  const started = Date.now();
  const maxTimeMS = Math.max(1, Math.floor(lim.timeoutMs));
  // 값의 { "$oid": ... }, { "$date": ... } 같은 표기를 실제 값으로 바꾼다.
  const real = <T>(v: T | undefined): T | undefined => (v === undefined ? undefined : EJSON.deserialize(v as Document, { relaxed: true }) as T);
  return withDb(t, lim.timeoutMs, async (db) => {
    if (cmd.op === 'ping') { await db.command({ ping: 1, maxTimeMS }); return { columns: ['ok'], rows: [[1]], truncated: false, ms: Date.now() - started }; }
    const col = db.collection(cmd.collection);
    if (cmd.op === 'count') {
      const n = await col.countDocuments(real(cmd.filter) ?? {}, { maxTimeMS, ...(cmd.skip ? { skip: cmd.skip } : {}), ...(cmd.limit ? { limit: cmd.limit } : {}) });
      return { columns: ['count'], rows: [[n]], truncated: false, ms: Date.now() - started };
    }
    if (cmd.op === 'distinct') {
      const values = await col.distinct(cmd.field!, real(cmd.filter) ?? {}, { maxTimeMS });
      return { columns: [cmd.field!], rows: values.slice(0, lim.maxRows).map((v) => [mongoCell(v)]), truncated: values.length > lim.maxRows, ms: Date.now() - started };
    }
    const take = Math.min(cmd.limit && cmd.limit > 0 ? cmd.limit : Infinity, lim.maxRows + 1);
    const cursor = cmd.op === 'aggregate'
      ? col.aggregate([...(real(cmd.pipeline) ?? []), { $limit: lim.maxRows + 1 }], { maxTimeMS, allowDiskUse: false, batchSize: 100 })
      : col.find(real(cmd.filter) ?? {}, { maxTimeMS, batchSize: 100, limit: take, ...(cmd.projection ? { projection: real(cmd.projection) } : {}), ...(cmd.sort ? { sort: real(cmd.sort) as never } : {}), ...(cmd.skip ? { skip: cmd.skip } : {}) });
    const docs: Record<string, DbCell>[] = [];
    const columns: string[] = [];
    let truncated = false;
    let bytes = 0;
    try {
      for await (const doc of cursor) {
        if (docs.length >= lim.maxRows) { truncated = true; break; }
        const row: Record<string, DbCell> = {};
        for (const [k, v] of Object.entries(doc)) {
          if (!columns.includes(k)) { if (columns.length >= MAX_COLUMNS) continue; columns.push(k); }
          const c = mongoCell(v);
          if (typeof c === 'string') bytes += c.length;
          row[k] = c;
        }
        if (bytes > (lim.maxBytes ?? DEFAULT_BYTES)) throw new Error('결과가 너무 큽니다. projection 으로 필요한 칸만 고르고 limit 으로 좁히세요.');
        docs.push(row);
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    return { columns, rows: docs.map((d) => columns.map((k) => d[k] ?? null)), truncated, ms: Date.now() - started };
  });
}

const SCHEMA_MS = 15_000;

/** 컬렉션과 뷰의 목록. 시스템 컬렉션은 뺀다. */
export function mongoTables(t: MongoTarget): Promise<DbTable[]> {
  return withDb(t, SCHEMA_MS, async (db) => {
    const list = await db.listCollections({}, { nameOnly: false, maxTimeMS: SCHEMA_MS }).toArray();
    return list.filter((c) => !/^system\./i.test(c.name)).slice(0, 3000)
      .map((c) => ({ schema: '', name: c.name, type: c.type === 'view' ? 'view' as const : 'table' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

const typeName = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  const b = (v as { _bsontype?: string })._bsontype;
  if (b) return b === 'ObjectId' ? 'objectId' : b === 'Long' || b === 'Int32' || b === 'Double' ? 'number' : b === 'Decimal128' ? 'decimal' : b.toLowerCase();
  return typeof v === 'object' ? 'object' : typeof v;
};

/**
 * 컬렉션의 칸 목록. 정해진 스키마가 없으므로 문서 200개를 보고 짐작한다: 이름, 보인 형식들, 빠진 문서가 있는지.
 * 키: P 는 _id, U 는 고유 인덱스, I 는 인덱스.
 */
export async function mongoColumns(t: MongoTarget, table: string): Promise<DbColumn[]> {
  const name = String(table ?? '').trim();
  if (!name || /^system\./i.test(name) || /[\0$]/.test(name)) throw new Error('컬렉션 이름이 올바르지 않습니다.');
  return withDb(t, SCHEMA_MS, async (db) => {
    const col = db.collection(name);
    const docs = await col.find({}, { limit: 200, maxTimeMS: SCHEMA_MS }).toArray();
    const seen = new Map<string, { types: Set<string>; n: number }>();
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        const e = seen.get(k) ?? { types: new Set<string>(), n: 0 };
        e.types.add(typeName(v)); e.n++;
        if (seen.size < MAX_COLUMNS || seen.has(k)) seen.set(k, e);
      }
    }
    const keys = new Map<string, string>();
    // 뷰에는 인덱스가 없다 (오류가 난다): 그때는 빼고 보인다.
    for (const ix of await col.indexes().catch(() => [])) for (const f of Object.keys(ix.key ?? {})) if (!keys.has(f) || ix.unique) keys.set(f, ix.unique ? 'U' : 'I');
    return [...seen].map(([k, e]) => ({
      name: k, type: [...e.types].filter((x) => x !== 'null').sort().join(' | ') || 'null',
      nullable: e.n < docs.length || e.types.has('null'), default: null, key: k === '_id' ? 'P' : keys.get(k) ?? '',
    }));
  });
}

const WRITES = ['insert', 'update', 'remove', 'createCollection', 'dropCollection', 'createIndex', 'dropIndex', 'dropDatabase', 'renameCollectionSameDB', 'collMod', 'convertToCapped', 'bypassDocumentValidation'];
const ADMIN = ['anyAction', 'shutdown', 'killop', 'killAnyCursor', 'killAnySession', 'setParameter', 'createUser', 'dropUser', 'grantRole', 'revokeRole', 'createRole', 'replSetConfigure', 'fsync', 'internal'];

/** 이 계정이 조회 말고 할 수 있는 것. 조회 전용 강제는 두레가 부르는 동작을 조회로 좁힌 것뿐이라, 계정이 읽기만 할 수 있는 것이 가장 안전하다. */
export async function mongoRisks(t: MongoTarget): Promise<string[]> {
  try {
    return await withDb(t, SCHEMA_MS, async (db) => {
      const r = await db.command({ connectionStatus: 1, showPrivileges: true, maxTimeMS: SCHEMA_MS });
      const info = (r.authInfo ?? {}) as { authenticatedUsers?: unknown[]; authenticatedUserPrivileges?: { actions?: string[] }[] };
      if (!info.authenticatedUsers?.length) return ['인증 없이 접속합니다 (이 서버는 누구나 읽고 쓸 수 있을 수 있습니다)'];
      const actions = new Set((info.authenticatedUserPrivileges ?? []).flatMap((p) => p.actions ?? []));
      return [
        ...(ADMIN.some((a) => actions.has(a)) ? ['관리자 권한이 있습니다 (서버 설정, 계정, 다른 세션에 닿을 수 있습니다)'] : []),
        ...(WRITES.some((a) => actions.has(a)) ? ['쓰기 권한이 있습니다 (읽기 전용 계정이 아닙니다)'] : []),
      ];
    });
  } catch {
    return ['계정의 권한을 확인하지 못했습니다'];
  }
}

/** 연결 문자열에서 화면에 보일 것만 뽑는다 (호스트, 포트, 사용자, DB 이름). 비밀번호는 돌려주지 않는다. */
export function mongoUriParts(uri: string): { host: string; port: number; user: string; database: string; srv: boolean } {
  const m = /^mongodb(\+srv)?:\/\/(?:([^:@/?]*)(?::[^@/?]*)?@)?([^/?]+)(?:\/([^?]*))?(?:\?.*)?$/.exec(String(uri ?? '').trim());
  if (!m) throw new Error('연결 문자열은 mongodb:// 나 mongodb+srv:// 로 시작해야 합니다.');
  const first = m[3]!.split(',')[0]!;
  const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(first);
  if (!hp) throw new Error('연결 문자열의 호스트가 올바르지 않습니다.');
  const dec = (s: string | undefined): string => { try { return decodeURIComponent(s ?? ''); } catch { return s ?? ''; } };
  return { host: hp[1]!, port: hp[2] ? Number(hp[2]) : 27017, user: dec(m[2]), database: dec(m[4]), srv: m[1] !== undefined };
}
