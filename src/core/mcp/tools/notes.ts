import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const OFF = '사용자가 에이전트에게 메모를 열어 두지 않았다. 메모의 내용이 필요하면 사용자에게 두레의 설정에서 "에이전트가 메모 읽기" 를 켜 달라고 하거나, 내용을 직접 알려 달라고 하라.';
const MAX_READ = 40_000;

/**
 * 사용자의 메모장을 읽고 적는 도구. 읽기와 쓰기는 사용자가 설정에서 따로 켠다.
 * 쓰기는 새 메모를 만들거나 끝에 덧붙이는 것뿐이다: 적힌 글을 고치거나 메모를 지우는 도구는 없다.
 */
const WRITE_OFF = '사용자가 에이전트에게 메모 쓰기를 열어 두지 않았다. 사용자에게 두레의 설정에서 "에이전트가 메모 쓰기" 를 켜 달라고 하라.';
/** 에이전트가 한 번에 적을 수 있는 글의 길이 */
const MAX_WRITE = 20_000;

export const noteTools: ToolBundle = (server, ctx, deps) => {
  // 누가 언제 적었는지 메모 안에 남긴다: 사용자가 나중에 봐도 자기가 적은 것과 가릴 수 있다.
  const stamp = (): string => {
    const d = new Date();
    const two = (n: number): string => String(n).padStart(2, '0');
    const who = ctx.workspace.role === 'coordinator' ? '조율 에이전트' : `"${ctx.workspace.name}" 에이전트`;
    return `${ctx.project.name} · ${who} · ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  };

  server.registerTool(
    'note_write',
    {
      description: '사용자의 메모장에 새 메모를 적는다 (사용자가 "메모해 줘" 라고 했을 때). 새 메모만 만든다: 이미 있는 메모를 고치거나 지우지 못한다. 있는 메모에 더 적으려면 note_append 를 쓴다. 사용자가 설정에서 켰을 때만 된다. 비밀 값(비밀번호, 토큰)은 적지 마라.',
      inputSchema: { title: z.string().max(200).optional().describe('메모의 제목 (짧게)'), body: z.string().describe('메모의 내용') },
    },
    async ({ title, body }) => {
      if (!deps.notesWriteForAgents()) return fail(WRITE_OFF);
      const text = String(body ?? '').trim();
      if (!text) return fail('메모의 내용이 없다.');
      if (text.length > MAX_WRITE) return fail(`한 번에 ${MAX_WRITE.toLocaleString()}자까지 적을 수 있다. 줄여서 적어라.`);
      try {
        const n = deps.notes.create({ title, body: `${text}\n\n— ${stamp()}` });
        return ok({ id: n.id, title: n.title || '(제목 없음)', saved: true, note: '사용자의 메모장에 적었다. 사용자는 두레의 "메모" 에서 볼 수 있다.' });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
  server.registerTool(
    'note_append',
    {
      description: '이미 있는 메모의 끝에 덧붙인다. 앞에 적힌 글은 바뀌지 않는다. 메모는 id (note_search 가 돌려준 값) 나 꼭 같은 제목으로 가리킨다. 사용자가 설정에서 켰을 때만 된다.',
      inputSchema: { id: z.string().optional().describe('메모의 id'), title: z.string().optional().describe('id 를 모를 때: 메모의 제목 (꼭 같아야 한다)'), text: z.string().describe('덧붙일 글') },
    },
    async ({ id, title, text }) => {
      if (!deps.notesWriteForAgents()) return fail(WRITE_OFF);
      const add = String(text ?? '').trim();
      if (!add) return fail('덧붙일 글이 없다.');
      if (add.length > MAX_WRITE) return fail(`한 번에 ${MAX_WRITE.toLocaleString()}자까지 적을 수 있다. 줄여서 적어라.`);
      let target = id ? deps.notes.get(id) : undefined;
      if (!target && title) {
        const same = deps.notes.byTitle(title);
        if (same.length > 1) return fail(`제목이 "${title}" 인 메모가 둘 이상이다. 사용자에게 어느 것인지 물어라.`);
        target = same[0];
      }
      if (!target) return fail('그런 메모가 없다. 새로 적으려면 note_write 를 써라.');
      try {
        const n = deps.notes.append(target.id, `[덧붙임 · ${stamp()}]\n${add}`);
        return ok({ id: n.id, title: n.title || '(제목 없음)', saved: true });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

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
