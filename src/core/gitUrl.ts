/**
 * 받아 와도 되는 git 주소인가: https 나 ssh 만, 옵션으로 읽힐 글자가 없고, https 주소에 계정이나 토큰이 들어 있지 않다
 * (주소는 설정에 그대로 저장되고 화면에 보인다. 인증은 git 의 자격 증명 도우미나 ssh 열쇠로 한다).
 */
export function gitUrlOk(u: string): boolean {
  if (typeof u !== 'string' || u.length > 300) return false;
  if (u.startsWith('https://')) return /^https:\/\/[\w.-]+(:\d{1,5})?\/[\w./~+-]+$/.test(u);
  return /^(git@|ssh:\/\/)[\w.@:/~+-]+$/.test(u);
}
