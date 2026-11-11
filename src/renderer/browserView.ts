/**
 * 주소창에 친 글을 열 주소로. http, https 만 연다 (file:, javascript: 같은 것은 열지 않는다).
 * 주소가 아니면 null.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  // 로컬 개발 서버는 http, 그 밖은 https 를 기본으로 한다.
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(raw) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw) ? raw : `${local ? 'http' : 'https'}://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const key = (workspaceId: string): string => `dure.browser.${workspaceId}`;
export function recallUrl(workspaceId: string, storage: Pick<Storage, 'getItem'> | undefined): string {
  try { return normalizeUrl(storage?.getItem(key(workspaceId)) ?? '') ?? ''; } catch { return ''; }
}
export function rememberUrl(workspaceId: string, url: string, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(key(workspaceId), url); } catch { /* 기억하지 못해도 된다 */ }
}

/** 통합 diff 의 한 줄이 무엇인지 (색을 입히는 데 쓴다). */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
    || line.startsWith('rename ') || line.startsWith('similarity ') || line.startsWith('Binary files') || line.startsWith('\\ ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
