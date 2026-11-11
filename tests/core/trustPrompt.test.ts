import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAnsi, trustPrompt } from '@core/agents/trustPrompt';

const FOLDER = '/private/var/folders/xx/T/my-repo';
const dialog = (cursor: 'no' | 'yes' | 'none' | 'both', folder = FOLDER): string => [
  ' Accessing workspace:', ` ${folder}`,
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from',
  " your team). If not, take a moment to review what's in this folder first.", " Claude Code'll be able to read, edit, and execute files here.", '   Security guide',
  `  ${cursor === 'no' || cursor === 'both' ? '❯' : ' '} No, exit`, ` ${cursor === 'yes' || cursor === 'both' ? '❯' : ' '} Yes, I trust this folder`, '   Enter to confirm · Esc to cancel',
].join('\n');

test('신뢰 창: 처음에는 커서가 No 에 있다', () => {
  expect(trustPrompt(dialog('no'), [FOLDER])).toBe('on-no');
});

test('신뢰 창: 커서가 Yes 로 옮겨졌다', () => {
  expect(trustPrompt(dialog('yes'), [FOLDER])).toBe('on-yes');
});

test('다시 그려진 화면에서는 마지막 창만 본다', () => {
  expect(trustPrompt(`${dialog('no')}\n${dialog('yes')}`, [FOLDER])).toBe('on-yes');
});

test('경로가 화면 폭 때문에 줄이 나뉘어도 알아본다', () => {
  const wrapped = dialog('no').replace(FOLDER, '/private/var/folders/xx/T/\n my-repo');
  expect(trustPrompt(wrapped, [FOLDER])).toBe('on-no');
});

test('다른 폴더를 묻는 창에는 답하지 않는다', () => {
  expect(trustPrompt(dialog('no', '/somewhere/else'), [FOLDER])).toBe('none');
  expect(trustPrompt(dialog('no'), [])).toBe('none');
  expect(trustPrompt(dialog('no'), [''])).toBe('none');
});

test('커서가 안 보이거나 둘 다로 보이면 판단하지 않는다', () => {
  expect(trustPrompt(dialog('none'), [FOLDER])).toBe('none');
  expect(trustPrompt(dialog('both'), [FOLDER])).toBe('none');
});

test('표지가 하나라도 없으면 신뢰 창이 아니다', () => {
  expect(trustPrompt(dialog('no').replace('Enter to confirm', 'Press something'), [FOLDER])).toBe('none');
  expect(trustPrompt(dialog('no').replace('Accessing workspace', 'Opening'), [FOLDER])).toBe('none');
  expect(trustPrompt(dialog('no').replace('No, exit', 'Nope'), [FOLDER])).toBe('none');
  expect(trustPrompt('', [FOLDER])).toBe('none');
  expect(trustPrompt('Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel', [FOLDER])).toBe('none');
  expect(trustPrompt('Update available\n ❯ Update now\n   Skip', [FOLDER])).toBe('none');
});

test('실제 Claude Code 가 낸 화면(제어 문자 포함)을 알아본다', () => {
  // 실험 15 에서 받은 원문. 폴더 이름만 바꿨다.
  const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/trust-dialog.json'), 'utf8')) as { raw: string; folder: string };
  expect(trustPrompt(raw.raw, [raw.folder])).toBe('on-no');
  expect(stripAnsi(raw.raw)).not.toMatch(/\x1b\[/);
});
