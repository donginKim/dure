/**
 * 워크스페이스 이름을 브랜치 이름과 폴더 이름으로 쓸 수 있는 형태로 바꾼다.
 * 한글은 그대로 둔다. git ref 에 쓸 수 없는 문자만 걷어낸다.
 */
export function slugify(name: string): string {
  let s = name.trim().replace(/\s+/g, '-');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[~^:?*[\]\\/\x00-\x1f\x7f]/g, '').replace(/@\{/g, '');
  while (s.includes('..')) s = s.replace(/\.\./g, '.');
  s = s.replace(/^[-.]+/, '').replace(/\.+$/, '').replace(/\.lock$/i, '');
  return s || 'ws';
}

/** base 가 이미 쓰이고 있으면 base-2, base-3 … 중 비어 있는 첫 이름을 고른다. */
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}
