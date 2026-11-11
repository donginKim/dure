// Claude Code 가 새 폴더에서 처음 뜰 때 묻는 "이 폴더를 신뢰하는가" 창을 화면 글자로 알아본다 (실험 15, 2.1.322).
//
//   Accessing workspace:
//   /path/to/folder
//   Quick safety check: Is this a project you created or one you trust? …
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
//
// 기본 선택은 "No, exit" 다. 아래 화살표로 한 칸 내린 뒤 Enter 를 눌러야 넘어간다.

export type TrustPrompt = 'none' | 'on-no' | 'on-yes';

/** 터미널 출력에서 색·커서 이동 같은 제어 문자열을 걷어 낸다. */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][0-9A-B]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>78]/g, '')
    .replace(/\r/g, '\n');
}

const squeeze = (s: string): string => s.replace(/\s+/g, '');

/**
 * 화면 끝부분이 신뢰 창인가, 그렇다면 커서가 어디에 있는가.
 * 창의 모든 표지(폴더 경로, 두 선택지, 안내문)가 보이고 그 폴더가 우리가 띄운 작업 폴더일 때만 창으로 본다.
 * 하나라도 다르면 'none': 모르는 창에는 아무것도 누르지 않는다.
 */
export function trustPrompt(screen: string, folders: string[]): TrustPrompt {
  const text = stripAnsi(screen);
  // 지금 떠 있는 창만 본다: 마지막 "Accessing workspace" 뒤.
  const at = text.lastIndexOf('Accessing workspace');
  if (at < 0) return 'none';
  const dialog = text.slice(at);
  if (!/Yes, I trust this folder/.test(dialog) || !/No, exit/.test(dialog) || !/Enter to confirm/.test(dialog)) return 'none';
  // 경로는 화면 폭에 따라 줄이 나뉜다. 공백을 모두 빼고 견준다.
  const flat = squeeze(dialog);
  if (!folders.some((f) => f && flat.includes(squeeze(f)))) return 'none';
  // 화면은 바뀐 줄만 다시 그려진다 (실험 15: 커서를 옮기면 옛 표시가 기록에 남는다). 가장 나중에 그려진 커서를 본다.
  const cursor = dialog.lastIndexOf('❯');
  if (cursor < 0) return 'none';
  const after = dialog.slice(cursor + 1);
  if (/^\s*Yes, I trust this folder/.test(after)) return 'on-yes';
  if (/^\s*No, exit/.test(after)) return 'on-no';
  return 'none';
}

/**
 * 터미널 화면이 프로그램의 물음에 스스로 돌려보내는 응답인가 (사람이 누른 키가 아니다).
 * 터미널 종류·버전 응답, 커서 위치 응답, 모드 응답, 색 응답, 창 초점 알림이 여기에 든다.
 * 이것을 사용자 입력으로 치면, 화면이 붙기만 해도 "사용자가 터미널을 쓰는 중" 으로 잘못 본다.
 */
export function isTerminalReply(data: string): boolean {
  if (!data) return false;
  // eslint-disable-next-line no-control-regex
  return /^(?:\x1b\[[?>=]?[\d;]*[cRn]|\x1b\[\?[\d;]*\$y|\x1b\[[IO]|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/.test(data);
}
