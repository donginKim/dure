import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Timeline } from '@core/chat/timeline';
import { MAX_RAW, parseLine, type Piece } from '@core/chat/transcript';

const start = (id: string, at = 1, tool = 'Bash', input: unknown = { command: `cmd-${id}` }): Piece => ({ type: 'tool-start', id, at, tool, input });
const end = (id: string, at = 2, o: Partial<Extract<Piece, { type: 'tool-end' }>> = {}): Piece => ({ type: 'tool-end', id, at, output: 'ok', error: false, denied: false, ...o });
const text = (id: string, t = '글', at = 3): Piece => ({ type: 'text', id, at, text: t });
const prompt = (id: string, t = '해줘', from: 'user' | 'dure' = 'user'): Piece => ({ type: 'prompt', id, at: 0, text: t, from });

test('글 사이의 연속된 도구 호출은 steps 하나로 묶인다', () => {
  const t = new Timeline();
  t.push([prompt('p'), start('a'), end('a'), start('b'), end('b'), text('x'), start('c')]);
  expect(t.items().map((i) => i.kind)).toEqual(['user', 'steps', 'assistant', 'steps']);
  const first = t.items()[1]!;
  expect(first.kind === 'steps' && first.steps.map((s) => s.id)).toEqual(['a', 'b']);
});

test('도구 결과가 오면 같은 단계가 done 이 되고 출력이 채워진다', () => {
  const t = new Timeline();
  t.push([start('a', 10)]);
  const step = () => { const i = t.items()[0]!; return i.kind === 'steps' ? i.steps[0]! : null; };
  expect(step()).toMatchObject({ status: 'running', output: null, endedAt: null, summary: 'cmd-a', input: 'cmd-a', startedAt: 10 });
  t.push([end('a', 25, { output: '결과' })]);
  expect(step()).toMatchObject({ status: 'done', output: '결과', endedAt: 25 });
});

test('오류와 거부는 각각 error, denied', () => {
  const t = new Timeline();
  t.push([start('a'), start('b'), end('a', 2, { error: true }), end('b', 2, { denied: true })]);
  const i = t.items()[0]!;
  expect(i.kind === 'steps' && i.steps.map((s) => s.status)).toEqual(['error', 'denied']);
});

test('짝이 없는 도구 결과는 무시한다', () => {
  const t = new Timeline();
  t.push([end('nope')]);
  expect(t.items()).toEqual([]);
});

test('두레의 프롬프트와 [두레] hook 글은 dure 항목, 다른 hook 글은 버린다', () => {
  const t = new Timeline();
  t.push([
    prompt('p', '[두레] 사용자가 TODO를 바꿨다:\n- 추가됨: "배포"', 'dure'),
    { type: 'hook-context', id: 'h1', at: 1, text: '[두레] 워크스페이스 "백엔드" 이(가) 보낸 메시지다.\n> 안녕' },
    { type: 'hook-context', id: 'h2', at: 1, text: 'CAVEMAN MODE ACTIVE' },
  ]);
  expect(t.items()).toEqual([
    { kind: 'dure', id: 'p', at: 0, title: '사용자가 TODO를 바꿨다:', text: '- 추가됨: "배포"' },
    { kind: 'dure', id: 'h1', at: 1, title: '워크스페이스 "백엔드" 이(가) 보낸 메시지다.', text: '> 안녕' },
  ]);
});

test('중단과 압축은 notice 가 되고, 중단되면 하는 중이던 단계가 끝난다', () => {
  const t = new Timeline();
  t.push([start('a'), { type: 'interrupted', id: 'i', at: 5 }, { type: 'compacted', id: 'c', at: 6 }]);
  expect(t.items().map((i) => (i.kind === 'notice' ? i.text : i.kind))).toEqual(['steps', '중단됨', expect.stringContaining('압축')]);
  const s = t.items()[0]!;
  expect(s.kind === 'steps' && s.steps[0]).toMatchObject({ status: 'denied', endedAt: 5 });
});

test('같은 조각을 두 번 넣어도 항목이 겹치지 않는다', () => {
  const t = new Timeline();
  const pieces = [prompt('p'), start('a'), end('a'), text('x')];
  t.push(pieces); t.push(pieces);
  expect(t.items().map((i) => i.kind)).toEqual(['user', 'steps', 'assistant']);
  const s = t.items()[1]!;
  expect(s.kind === 'steps' && s.steps.length).toBe(1);
});

test('긴 입력은 20000자에서 잘리고 생략 표시가 붙는다', () => {
  const t = new Timeline();
  t.push([start('a', 1, 'Bash', { command: 'x'.repeat(MAX_RAW + 5) })]);
  const s = t.items()[0]!;
  expect(s.kind === 'steps' && s.steps[0]!.input.endsWith('… (5자 생략)')).toBe(true);
});

test('reset 뒤에는 비어 있고 같은 조각을 다시 받는다', () => {
  const t = new Timeline();
  t.push([prompt('p')]);
  t.reset();
  expect(t.items()).toEqual([]);
  t.push([prompt('p')]);
  expect(t.items().length).toBe(1);
});

test('표본 파일로 만든 대화의 흐름', () => {
  const t = new Timeline();
  for (const line of readFileSync(join(__dirname, '../fixtures/transcript-basic.jsonl'), 'utf8').split('\n')) t.push(parseLine(line));
  const kinds = t.items().map((i) => i.kind);
  expect(kinds[0]).toBe('dure'); // SessionStart 에 넣은 글
  expect(kinds.slice(1, 3)).toEqual(['user', 'assistant']);
  expect(kinds.filter((k) => k === 'user').length).toBe(7);
  expect(kinds.at(-1)).toBe('notice');
  const steps = t.items().flatMap((i) => (i.kind === 'steps' ? i.steps : []));
  expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'denied']);
  expect(steps[0]!.summary).toBe('README.md 읽음');
});
