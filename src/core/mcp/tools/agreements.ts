import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

/** 프로젝트의 약속 (API 형식, 이름 규칙, 정한 것). 에이전트는 읽고, 제안만 한다. 약속이 되는 것은 사용자가 받아들일 때다. */
export const agreementTools: ToolBundle = (server, ctx, deps) => {
  server.registerTool(
    'agreements_list',
    { description: '이 프로젝트의 약속(API 형식, 이름 규칙, 사용자와 정한 것)을 읽는다. 모든 워크스페이스가 이것을 따른다. 일을 시작할 때와 다른 워크스페이스와 맞물리는 일(API, 공용 이름)을 하기 전에 읽어라.', inputSchema: {} },
    async () => ok({
      agreements: deps.agreements.list(ctx.project.id).map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, by: a.author })),
      waiting: deps.agreements.list(ctx.project.id, { proposed: true }).filter((a) => a.status === 'proposed').map((a) => ({ title: a.title, by: a.author, note: '제안됐고 사용자가 아직 정하지 않았다. 아직 약속이 아니다' })),
    }),
  );

  server.registerTool(
    'agreement_propose',
    {
      description: [
        '약속을 제안한다: 여러 워크스페이스가 같이 지켜야 하는 것 (API 의 경로와 요청·응답 형식, 공용 타입과 이름, 오류 형식, 정한 방침).',
        '사용자가 받아들여야 약속이 된다. 받아들이면 두레가 모든 워크스페이스에 알린다. 그 전에는 약속이 아니다.',
        '이미 있는 약속을 바꾸자면 replaces 에 그 id 를 적어라. 혼자만 쓰는 것, 곧 바뀔 것은 제안하지 마라.',
      ].join(' '),
      inputSchema: {
        kind: z.enum(['api', 'naming', 'decision', 'other']).describe('api: API 형식, naming: 이름 규칙, decision: 정한 방침'),
        title: z.string().describe('한 줄 제목 (예: "POST /login 요청과 응답")'),
        body: z.string().describe('내용 (마크다운). 다른 에이전트가 이것만 보고 맞춰 일할 수 있게 구체적으로 (예시 JSON, 필드 이름과 형식)'),
        replaces: z.string().optional().describe('바꾸자는 약속의 id (agreements_list)'),
      },
    },
    async ({ kind, title, body, replaces }) => {
      try {
        const a = deps.agreements.propose(ctx.project.id, ctx.workspace.role === 'coordinator' ? '조율 에이전트' : ctx.workspace.name, { kind, title, body, replaces });
        return ok({ id: a.id, status: '사용자의 확인을 기다린다. 받아들이면 두레가 알려 준다. 그때까지는 약속이 아니니 이것에 기대어 다른 워크스페이스에 일을 시키지 마라.' });
      } catch (e) { return fail(e); }
    },
  );
};
