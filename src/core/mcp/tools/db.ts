import { z } from 'zod';
import type { AgentAnswer } from '../../dbService';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

const answer = (a: AgentAnswer) => (a.kind === 'pending'
  ? ok({ status: '사용자의 승인을 기다리는 중이다', request_id: a.requestId, next: '다른 일을 하거나 턴을 끝내라. 사용자가 결정하면 두레가 [두레] 알림으로 알려 준다. 그때 db_result 에 이 request_id 를 줘서 결과를 받아라. 같은 조회를 다시 요청하지 마라.' })
  : ok({ columns: a.result.columns, rows: a.result.rows, truncated: a.result.truncated, note: a.note }));

/**
 * DB 조회 도구. 사용자가 두레의 DB 탭에 등록한 연결을 이름으로 쓴다. 조회 전용이다.
 * 에이전트에게는 연결의 이름과 종류만 보인다. 호스트, 사용자, 비밀번호는 넘어가지 않는다.
 */
export const dbTools: ToolBundle = (server, ctx, deps) => {
  server.registerTool(
    'db_list',
    { description: '이 프로젝트에 사용자가 등록한 DB 연결의 목록을 돌려준다 (이름, 종류, 조회할 때 사용자의 승인이 필요한지). 비밀번호를 비롯한 접속 정보는 주지 않는다.', inputSchema: {} },
    async () => ok({
      connections: deps.dbs.list(ctx.project.id).filter((c) => c.agentAccess !== 'off').map((c) => ({
        name: c.name, kind: c.kind,
        query: c.agentAccess === 'auto' && !c.warnings?.length ? '바로 조회된다' : '조회마다 사용자의 승인을 받는다 (표 목록과 스키마는 바로 볼 수 있다)',
      })),
      note: '조회 전용이다. 쓰기, 스키마 변경은 할 수 없다. 접속 정보를 저장소나 환경에서 찾아 직접 접속하려 하지 마라.',
    }),
  );

  server.registerTool(
    'db_tables',
    { description: 'DB 연결의 표와 뷰 목록을 돌려준다.', inputSchema: { connection: z.string().describe('db_list 가 돌려준 연결 이름') } },
    async ({ connection }) => {
      try { return ok({ tables: await deps.dbs.agentTables(ctx.project.id, connection) }); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'db_columns',
    {
      description: '표 하나의 칸 목록(이름, 형식, NULL 허용, 기본값, 키)을 돌려준다.',
      inputSchema: { connection: z.string(), table: z.string(), schema: z.string().optional().describe('PostgreSQL 이나 Oracle 의 스키마 (db_tables 가 돌려준 값). 비우면 PostgreSQL 은 public, Oracle 은 접속한 계정의 스키마') },
    },
    async ({ connection, table, schema }) => {
      try {
        const kind = deps.dbs.list(ctx.project.id).find((c) => c.name === connection.trim())?.kind;
        return ok({ columns: await deps.dbs.agentColumns(ctx.project.id, connection, schema ?? (kind === 'postgres' ? 'public' : ''), table) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'db_query',
    {
      description: [
        'DB 를 조회한다. 조회 전용이다: SELECT, WITH, SHOW, EXPLAIN 으로 시작하는 문장 하나만 실행된다.',
        '한 번에 100행, 10초까지다. 필요한 칸만 고르고 WHERE 와 LIMIT 로 좁혀라.',
        '연결에 따라 사용자의 승인을 받는다. 승인을 기다리는 중이라고 돌아오면 다시 요청하지 말고 두레의 알림을 기다려라.',
        '결과에는 실제 데이터가 들어 있다. 필요한 만큼만 조회하고, 개인 정보는 응답이나 파일에 옮겨 적지 마라.',
      ].join(' '),
      inputSchema: { connection: z.string().describe('db_list 가 돌려준 연결 이름'), sql: z.string().describe('조회 문장 하나') },
    },
    async ({ connection, sql }) => {
      try { return answer(await deps.dbs.agentQuery(ctx.workspace.id, connection, sql)); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'db_result',
    { description: '승인을 기다리던 조회의 결과를 받는다. db_query 가 돌려준 request_id 를 준다.', inputSchema: { request_id: z.string() } },
    async ({ request_id }) => {
      try { return answer(deps.dbs.agentResult(ctx.workspace.id, request_id)); } catch (e) { return fail(e); }
    },
  );
};
