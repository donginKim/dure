import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminalReply, stripAnsi, trustPrompt } from '@core/agents/trustPrompt';

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

test('커서가 안 보이면 판단하지 않는다', () => {
  expect(trustPrompt(dialog('none'), [FOLDER])).toBe('none');
  expect(trustPrompt(`${dialog('none')}\n ❯ 다른 무언가`, [FOLDER])).toBe('none');
});

test('바뀐 줄만 다시 그려져 옛 커서 표시가 남아 있으면 나중에 그려진 커서를 본다', () => {
  // 실제 화면: 아래로 내리면 두 선택지 줄만 다시 그려진다
  const moved = `${dialog('no')}\n   No, exit\n ❯ Yes, I trust this folder\n   Enter to confirm · Esc to cancel`;
  expect(trustPrompt(moved, [FOLDER])).toBe('on-yes');
  const movedBack = `${moved}\n ❯ No, exit\n   Yes, I trust this folder`;
  expect(trustPrompt(movedBack, [FOLDER])).toBe('on-no');
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

test('isTerminalReply: 화면이 스스로 보내는 응답은 참', () => {
  for (const reply of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[?2026;2$y', '\x1b[I', '\x1b[O',
    '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b]11;rgb:0f0f/1111/1515\x1b\\', '\x1b]10;rgb:e6e6/e8e8/eeee\x07', '\x1b[?1;2c\x1b[>0;276;0c']) {
    expect(isTerminalReply(reply)).toBe(true);
  }
});

test('isTerminalReply: 사람이 누른 키와 붙여 넣은 글은 거짓', () => {
  for (const key of ['', 'a', '\r', '\x1b', '\x1b[A', '\x1b[B', '\x1b[200~안녕\x1b[201~', '한글', '\x03', '\x1b[?1;2ca', 'x\x1b[I', '\x1b[1;5C', '\x1bOP']) {
    expect(isTerminalReply(key)).toBe(false);
  }
});
