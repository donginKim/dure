/** 원격 저장소의 주소에서 어느 서비스의 어느 저장소인지 알아낸다. 모르는 꼴이면 null. */
export type PrHost = 'github' | 'bitbucket' | 'gitlab';
export interface RemoteRepo { host: PrHost; /** 웹 주소 (https://github.com/누구/저장소) */ web: string }

export function parseRemote(url: string | null | undefined): RemoteRepo | null {
  const u = String(url ?? '').trim();
  // git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git, https://github.com/owner/repo(.git)
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const domain = m[1]!.toLowerCase().replace(/^ssh\./, '');
  const path = m[2]!.replace(/^\/+/, '');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null;
  const host: PrHost | null = domain === 'github.com' ? 'github' : domain === 'bitbucket.org' ? 'bitbucket' : domain === 'gitlab.com' ? 'gitlab' : null;
  return host ? { host, web: `https://${domain}/${path}` } : null;
}

/** PR (병합 요청) 을 만드는 웹 화면의 주소. 브랜치 이름은 주소에 넣을 수 있게 바꾼다. */
export function prUrl(r: RemoteRepo, base: string, head: string): string {
  const b = encodeURIComponent(base); const h = encodeURIComponent(head);
  if (r.host === 'github') return `${r.web}/compare/${b}...${h}?expand=1`;
  if (r.host === 'bitbucket') return `${r.web}/pull-requests/new?source=${h}&dest=${b}`;
  return `${r.web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${h}&merge_request%5Btarget_branch%5D=${b}`;
}
