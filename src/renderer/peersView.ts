import { isRemoteRef } from '@shared/remote';
import type { PeerMode, PeerStatus, SharingAudience } from '@shared/types';

export const MODE_LABEL: Record<PeerMode, string> = { review: '내가 보고 넘겨주기', direct: '바로 전달' };
export const MODE_HELP: Record<PeerMode, string> = {
  review: '이 사람의 에이전트가 보낸 메시지는 내가 확인하고 "넘겨주기" 를 눌러야 내 에이전트에게 갑니다.',
  direct: '이 사람의 에이전트가 보낸 메시지가 곧장 내 에이전트에게 갑니다. 믿는 사람에게만 쓰세요.',
};
export const AUDIENCE_LABEL: Record<SharingAudience, string> = { none: '비공개', all: '참여자 전체', selected: '고른 사람만' };

/** 내 상태 한 줄. */
export function statusLine(s: PeerStatus): string {
  if (!s.enabled) return '꺼져 있습니다. 켜면 같은 네트워크의 다른 두레가 나를 찾을 수 있습니다.';
  if (s.error) return `켜지 못했습니다: ${s.error}`;
  if (s.port === null) return '켜는 중…';
  return `켜져 있습니다 · 포트 ${s.port} · 내 이름 "${s.name}" · 열쇠 지문 ${s.fingerprint}`;
}

/** 확인 코드를 읽기 쉽게: 123 456 */
export const spokenCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** 주소로 쓸 수 있는 글인가. 포트를 안 적으면 기본 포트를 붙인다. 안 되면 null */
export function normalizeAddress(raw: string, defaultPort = 47800): string | null {
  const t = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!t || /\s/.test(t)) return null;
  const withPort = /:\d{1,5}$/.test(t) ? t : `${t}:${defaultPort}`;
  if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(withPort)) return null;
  const port = Number(withPort.split(':').pop());
  return port > 0 && port < 65536 ? withPort : null;
}

// 다른 사람의 워크스페이스의 이름표 (ref → "워크스페이스@사람"). App 이 받아서 넣어 둔다.
let names: Record<string, string> = {};
export const setRemoteNames = (next: Record<string, string>): void => { names = next; };
export const remoteName = (id: string): string | undefined => (isRemoteRef(id) ? names[id] ?? '다른 사람의 워크스페이스' : undefined);
