// 셸에서 한 낱말로 읽히게 작은따옴표로 감싼다.
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 에이전트 터미널의 PATH 맨 앞에 두는 git 대리 실행 파일.
 * 하위 명령이 commit 또는 push 면 거절하고, 나머지는 진짜 git 으로 그대로 넘긴다.
 *
 * 커밋과 push 는 사용자가 두레 화면에서 직접 한다. 허용하는 길이 없으므로 두레에 묻지 않고 그 자리에서 거절한다.
 * 실수와 지침 이탈을 막는 장치이지 보안 경계는 아니다: 진짜 git 을 절대 경로로 부르거나
 * merge, rebase 처럼 커밋을 만드는 다른 명령을 쓰는 것은 막지 않는다.
 */
export function gitShimScript(realGit: string): string {
  return `#!/bin/sh
# 두레가 만든 파일. 에이전트의 git commit, git push 를 막는다.
REAL=${shq(realGit)}

# 하위 명령 찾기: 전역 옵션을 건너뛰고 처음 나오는 낱말. 값을 따로 받는 옵션은 그 값도 건너뛴다.
sub=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env) skip=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done

case "$sub" in
  commit)
    printf '%s\\n' \\
      '[두레] git commit 은 사용자가 두레 화면에서 직접 한다. 에이전트는 커밋하지 않는다.' \\
      '지금 할 일: 커밋 메시지를 commit_draft_save 도구로 저장하고, 사용자에게 커밋할 준비가 됐다고 알려라.' >&2
    exit 1 ;;
  push)
    printf '%s\\n' '[두레] git push 는 사용자가 두레 화면에서 직접 한다. 에이전트는 push 하지 않는다.' >&2
    exit 1 ;;
esac

exec "$REAL" "$@"
`;
}
