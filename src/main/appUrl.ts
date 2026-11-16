import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 두레 자신의 화면 주소 (묶은 앱은 파일, 개발 중에는 개발 서버). */
const base = (): string => process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).toString();

/**
 * 이 주소가 두레 자신의 화면인가. 두레의 기능(IPC)은 여기서 온 요청만 받는다:
 * 어쩌다 창이 다른 페이지로 넘어가도 그 페이지가 두레를 부리지 못한다.
 */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const plain = url.split('#')[0]!.split('?')[0]!;
  const b = base();
  if (process.env.ELECTRON_RENDERER_URL) { try { return new URL(plain).origin === new URL(b).origin; } catch { return false; } }
  return plain === b;
}
