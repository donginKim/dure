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
  const yes = /❯\s*Yes, I trust this folder/.test(dialog);
  const no = /❯\s*No, exit/.test(dialog);
  if (yes === no) return 'none'; // 커서가 안 보이거나 둘 다로 보이면 판단하지 않는다
  return yes ? 'on-yes' : 'on-no';
}
