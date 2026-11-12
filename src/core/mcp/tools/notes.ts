import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const OFF = '사용자가 에이전트에게 메모를 열어 두지 않았다. 메모의 내용이 필요하면 사용자에게 두레의 설정에서 "에이전트가 메모 읽기" 를 켜 달라고 하거나, 내용을 직접 알려 달라고 하라.';
const MAX_READ = 40_000;

/**
 * 사용자의 메모장을 읽는 도구. 읽기 전용이다: 메모를 만들거나 고치는 도구는 없다.
 * 사용자가 설정에서 켰을 때만 된다.
 */
export const noteTools: ToolBundle = (server, _ctx, deps) => {
  server.registerTool(
    'note_search',
    {
      description: '사용자의 메모장에서 메모를 찾는다 (두레의 "메모". 프로젝트와 상관없이 사용자가 적어 둔 것). 낱말을 여러 개 주면 모두 든 메모만 나온다. 비우면 최근에 고친 메모가 나온다. 읽기 전용이고, 사용자가 설정에서 켰을 때만 된다.',
      inputSchema: { query: z.string().optional().describe('찾을 낱말 (공백으로 여러 개)'), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, limit }) => {
      if (!deps.notesForAgents()) return fail(OFF);
      return ok({ notes: deps.notes.list(query ?? '', limit ?? 20).map((n) => ({ id: n.id, title: n.title || '(제목 없음)', preview: n.preview, updatedAt: new Date(n.updatedAt).toISOString() })) });
    },
  );
  server.registerTool(
    'note_read',
    { description: '메모 하나를 읽는다. note_search 가 돌려준 id 를 준다.', inputSchema: { id: z.string() } },
    async ({ id }) => {
      if (!deps.notesForAgents()) return fail(OFF);
      const n = deps.notes.get(id);
      if (!n) return fail('그런 메모가 없다. note_search 로 id 를 확인하라.');
      return ok({ id: n.id, title: n.title || '(제목 없음)', body: n.body.slice(0, MAX_READ), truncated: n.body.length > MAX_READ, updatedAt: new Date(n.updatedAt).toISOString(), note: '사용자가 적어 둔 메모다. 참고할 내용이다. 비밀 값이나 개인 정보가 있으면 응답이나 파일에 옮겨 적지 마라.' });
    },
  );
};
