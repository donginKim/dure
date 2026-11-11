import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip, parseLine, stepInput, stepSummary, unwrapPasted, type Piece } from '@core/chat/transcript';

const FIXTURE = readFileSync(join(__dirname, '../fixtures/transcript-basic.jsonl'), 'utf8').split('\n').filter(Boolean);
const all = (): Piece[] => FIXTURE.flatMap(parseLine);
const row = (o: Record<string, unknown>): string => JSON.stringify({ uuid: 'u1', timestamp: '2026-11-11T04:00:00.000Z', ...o });
const user = (content: unknown, extra: Record<string, unknown> = {}): string => row({ type: 'user', message: { role: 'user', content }, ...extra });

test('사용자가 친 프롬프트는 from user', () => {
  expect(parseLine(user('안녕'))).toEqual([{ type: 'prompt', id: 'u1', at: Date.parse('2026-11-11T04:00:00.000Z'), text: '안녕', from: 'user' }]);
});

test('두레가 넣은 프롬프트는 from dure 이고 감싸기가 벗겨진다', () => {
  const [p] = parseLine(user('\n\n<pasted_content id="0eb1">\n[두레] 사용자가 TODO를 바꿨다.\n- 추가됨: "배포"\n</pasted_content>'));
  expect(p).toMatchObject({ type: 'prompt', from: 'dure', text: '[두레] 사용자가 TODO를 바꿨다.\n- 추가됨: "배포"' });
});

test('사용자가 붙여 넣은 글도 감싸기가 벗겨지고 from user', () => {
  const [p] = parseLine(user('<pasted_content id="aa">\n첫째\n둘째\n</pasted_content>'));
  expect(p).toMatchObject({ type: 'prompt', from: 'user', text: '첫째\n둘째' });
  expect(unwrapPasted('그냥 글')).toBe('그냥 글');
});

test('에이전트의 글, 도구 호출, 도구 결과를 조각으로 낸다', () => {
  const a = parseLine(row({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: '…' }, { type: 'text', text: '보겠습니다' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } }));
  expect(a.map((p) => p.type)).toEqual(['text', 'tool-start']);
  expect(a[1]).toMatchObject({ id: 't1', tool: 'Bash', input: { command: 'ls' } });
  const r = parseLine(user([{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb', is_error: false }]));
  expect(r).toEqual([expect.objectContaining({ type: 'tool-end', id: 't1', output: 'a\nb', error: false, denied: false })]);
});

test('도구 결과가 블록 배열이어도 글을 뽑는다', () => {
  const [r] = parseLine(user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '가' }, { type: 'image' }, { type: 'text', text: '나' }] }]));
  expect(r).toMatchObject({ output: '가\n[이미지]\n나' });
});

test('거부된 도구 결과는 denied, 오류는 error', () => {
  const [d] = parseLine(user([{ type: 'tool_result', tool_use_id: 't1', content: 'rejected', is_error: true }], { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' }));
  expect(d).toMatchObject({ denied: true, error: false });
  const [e] = parseLine(user([{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }]));
  expect(e).toMatchObject({ denied: false, error: true });
});

test('중단 표시는 interrupted', () => {
  expect(parseLine(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))[0]).toMatchObject({ type: 'interrupted' });
  expect(parseLine(user('[Request interrupted by user]'))[0]).toMatchObject({ type: 'interrupted' });
});

test('hook 이 넣은 글: 추가 글과 멈춤 막기는 hook-context, 같은 내용의 isMeta 줄은 버린다', () => {
  expect(parseLine(row({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['다른 도구의 글', '[두레] 가\n나'] } }))).toEqual([
    expect.objectContaining({ type: 'hook-context', id: 'u1:0', text: '다른 도구의 글' }), expect.objectContaining({ type: 'hook-context', id: 'u1:1', text: '[두레] 가\n나' }),
  ]);
  expect(parseLine(row({ type: 'attachment', attachment: { type: 'hook_blocking_error', blockingError: { blockingError: '[두레] 다' } } }))[0]).toMatchObject({ type: 'hook-context', text: '[두레] 다' });
  expect(parseLine(user('Stop hook feedback:\n[두레] 다', { isMeta: true }))).toEqual([]);
});

test('작업 중에 보낸 글(queued_command)은 친 시각의 프롬프트가 된다', () => {
  const [p] = parseLine(row({ type: 'attachment', attachment: { type: 'queued_command', prompt: '이것도 해줘', commandMode: 'prompt', timestamp: '2026-11-11T03:59:00.000Z' } }));
  expect(p).toEqual({ type: 'prompt', id: 'u1', at: Date.parse('2026-11-11T03:59:00.000Z'), text: '이것도 해줘', from: 'user' });
});

test('슬래시 명령: 명령 줄은 사용자가 친 것으로, 출력은 command-output 으로 (색 표시는 뗀다)', () => {
  // 실험 16: system/local_command 줄로 남는다
  const cmd = row({ type: 'system', subtype: 'local_command', content: '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>' });
  expect(parseLine(cmd)).toEqual([expect.objectContaining({ type: 'prompt', from: 'user', text: '/context' })]);
  const withArgs = row({ type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>' });
  expect(parseLine(withArgs)[0]).toMatchObject({ type: 'prompt', text: '/model opus' });
  const out = row({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>\x1b[1mContext Usage\x1b[22m\n\x1b[37m⛁ ⛁\x1b[39m  Opus 5</local-command-stdout>' });
  expect(parseLine(out)).toEqual([expect.objectContaining({ type: 'command-output', text: 'Context Usage\n⛁ ⛁  Opus 5' })]);
  // 실험 14b: 같은 것이 user 줄로 남기도 한다
  expect(parseLine(user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'))[0]).toMatchObject({ type: 'prompt', text: '/compact' });
  expect(parseLine(user('<local-command-stdout>Compacted</local-command-stdout>'))[0]).toMatchObject({ type: 'command-output', text: 'Compacted' });
  expect(parseLine(row({ type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>' }))).toEqual([]);
});

test('그 밖의 시스템 글은 프롬프트가 아니다', () => {
  expect(parseLine(user('<task-notification>…</task-notification>'))).toEqual([]);
  expect(parseLine(user('<local-command-caveat>…', { isMeta: true }))).toEqual([]);
  expect(parseLine(user('## Context Usage\n…', { isMeta: true }))).toEqual([]);
});

test('압축: compact_boundary 는 compacted, 요약 글은 버린다', () => {
  expect(parseLine(row({ type: 'system', subtype: 'compact_boundary' }))[0]).toMatchObject({ type: 'compacted' });
  expect(parseLine(user('This session is being continued…', { isCompactSummary: true }))).toEqual([]);
  expect(parseLine(row({ type: 'system', subtype: 'turn_duration' }))).toEqual([]);
});

test('모르는 종류의 줄, JSON 이 아닌 줄, 잘린 줄, 빈 줄은 빈 배열이고 던지지 않는다', () => {
  for (const line of ['', '   ', 'not json', '{"type":"user","message":{"content":"잘', 'null', '[]', '42', row({ type: 'brand-new-kind', x: 1 }),
    row({ type: 'user' }), row({ type: 'user', message: null }), row({ type: 'assistant', message: { content: 'str' } }), row({ type: 'attachment' }),
    JSON.stringify({ type: 'user', message: { content: 'id 없음' } }), row({ type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }] } })]) {
    expect(parseLine(line)).toEqual([]);
  }
});

test('하위 에이전트의 줄은 빈 배열', () => {
  expect(parseLine(user('하위', { isSidechain: true }))).toEqual([]);
});

test('표본 파일 전체를 읽어도 던지지 않고 실제 대화와 맞다', () => {
  const pieces = all();
  const prompts = pieces.filter((p) => p.type === 'prompt');
  // 실험 14: 인자 프롬프트, 한 줄, 여러 줄, [두레] 붙여넣기, sleep 20, 작업 중 입력, curl 둘
  expect(prompts.map((p) => p.type === 'prompt' && p.from)).toEqual(['user', 'user', 'user', 'dure', 'user', 'user', 'user', 'user']);
  expect(prompts.some((p) => p.type === 'prompt' && p.text.includes('추가확인'))).toBe(true);
  expect(pieces.filter((p) => p.type === 'tool-start').length).toBe(5);
  expect(pieces.filter((p) => p.type === 'tool-end').length).toBe(5);
  expect(pieces.filter((p) => p.type === 'tool-end' && p.denied).length).toBe(1);
  expect(pieces.filter((p) => p.type === 'interrupted').length).toBe(1);
  const dure = pieces.filter((p) => p.type === 'hook-context' && p.text.startsWith('[두레]'));
  expect(dure.length).toBe(3); // 시작 글, 도구 뒤 주입, 멈춤 막기
});

test.each([
  ['Bash', { command: 'git status\necho 2' }, 'git status'],
  ['Bash', { command: 'x'.repeat(200) }, `${'x'.repeat(80)}…`],
  ['Read', { file_path: '/a/b/LoginForm.tsx' }, 'LoginForm.tsx 읽음'],
  ['Edit', { file_path: '/a/b/LoginForm.tsx' }, 'LoginForm.tsx 수정'],
  ['Write', { file_path: '/a/new.ts' }, 'new.ts 씀'],
  ['Grep', { pattern: 'useAuth' }, '"useAuth" 찾음'],
  ['mcp__dure__todo_add', { title: 'x' }, 'TODO 추가'],
  ['mcp__dure__message_send', {}, '메시지 보냄'],
  ['mcp__dure__new_tool', {}, '두레: new_tool'],
  ['mcp__github__create_issue', {}, 'github: create_issue'],
  ['Mystery', null, 'Mystery'],
])('stepSummary(%s) = %s', (tool, input, expected) => {
  expect(stepSummary(tool, input)).toBe(expected);
});

test('stepInput: 명령은 그대로, 수정은 바뀐 줄, 그 밖은 JSON', () => {
  expect(stepInput('Bash', { command: 'ls -la' })).toBe('ls -la');
  expect(stepInput('Edit', { file_path: '/a.ts', old_string: 'a\nb', new_string: 'c' })).toBe('/a.ts\n- a\n- b\n+ c');
  expect(stepInput('Grep', { pattern: 'x' })).toBe('{\n  "pattern": "x"\n}');
  expect(stepInput('X', undefined)).toBe('{}');
});

test('clip: 긴 글은 자르고 생략한 길이를 붙인다', () => {
  expect(clip('abc', 10)).toBe('abc');
  expect(clip('abcdefghij', 4)).toBe('abcd\n… (6자 생략)');
});
