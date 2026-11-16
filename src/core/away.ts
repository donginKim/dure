// 되돌리기 어렵거나 밖으로 나가는 일을 가리키는 말
const RISKY = /삭제|지우|지움|지워|제거|없애|폐기|초기화|덮어|되돌릴 수 없|되돌리기 어려|강제|배포|출시|공개|내보내|전송|업로드|결제|송금|권한|비밀|토큰|(?<![a-z])(delete|remove|drop|truncate|reset|force|overwrite|wipe|destroy|deploy|publish|release|push|upload|send|pay|sudo|rm|chmod|token|secret|credential)s?(?![a-z])/i;

/**
 * 자리 비움이 대신 고르면 안 되는 질문인가. 질문과 선택지의 글은 에이전트가 쓴다:
 * 남이 보낸 글에 휘둘린 에이전트가 "지우기 진행(추천)" 을 첫째에 두어도, 사용자가 본 적 없는 동의가 생기지 않게 한다.
 */
export function riskyChoice(text: string): boolean {
  return RISKY.test(text);
}
