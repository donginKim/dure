import { DoingService, describeTool } from '@core/doing';

test('describeTool: 도구 사용을 짧은 말로', () => {
  expect(describeTool('Edit', { file_path: '/a/b/api.ts' })).toBe('고치는 중: api.ts');
  expect(describeTool('Bash', { command: 'pnpm test', description: '시험 돌리기' })).toBe('명령: 시험 돌리기');
  expect(describeTool('Bash', { command: 'x'.repeat(100) })).toMatch(/^명령: x{50}…$/);
  expect(describeTool('mcp__dure__todo_update', {})).toBe('두레: todo_update');
  expect(describeTool('Read', null)).toBe('읽는 중: ');
});

test('DoingService: 도구를 쓰면 적고, 멈추거나 비우면 지운다', async () => {
  const d = new DoingService();
  let n = 0; d.on('changed', () => { n++; });
  d.note('w1', 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'login' } });
  d.note('w1', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'x/login.ts' } });
  expect(d.all().w1!.text).toBe('고치는 중: login.ts');
  await new Promise((r) => setTimeout(r, 900));
  expect(n).toBe(1);
  d.note('w1', 'Stop', {});
  expect(d.all()).toEqual({});
  d.note('w2', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } });
  d.clear('w2');
  expect(d.all()).toEqual({});
  d.dispose();
});
