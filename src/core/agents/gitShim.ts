// 셸에서 한 낱말로 읽히게 작은따옴표로 감싼다.
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 에이전트 터미널의 PATH 맨 앞에 두는 git 대리 실행 파일.
 * 이 워크스페이스의 저장소(같은 저장소의 다른 작업 폴더 포함)에 대한 commit, push 를 거절하고, 나머지는 진짜 git 으로 넘긴다.
 *
 * - 커밋과 push 는 사용자가 두레 화면에서 직접 한다. 허용하는 길이 없으므로 두레에 묻지 않고 그 자리에서 거절한다.
 * - 다른 저장소의 커밋은 막지 않는다: 테스트가 임시 저장소를 만들어 커밋하는 프로젝트가 깨지지 않게 한다.
 * - 사용자의 git 별칭(ci = commit 등)으로 돌아가는 commit, push 도 거절한다.
 * - 실수와 지침 이탈을 막는 장치이지 보안 경계는 아니다: 진짜 git 을 절대 경로로 부르거나
 *   merge, rebase 처럼 커밋을 만드는 다른 명령을 쓰는 것은 막지 않는다.
 *
 * @param realGit 진짜 git 의 절대 경로
 * @param gitCommonDir 막을 저장소의 공용 .git 폴더 (실제 경로). 조율 에이전트는 등록된 저장소 전부를 준다
 */
export function gitShimScript(realGit: string, gitCommonDir: string | string[]): string {
  const commons = (Array.isArray(gitCommonDir) ? gitCommonDir : [gitCommonDir]).filter((c) => c && !c.includes('\n'));
  return `#!/bin/sh
# 두레가 만든 파일. 에이전트가 이 워크스페이스의 저장소에 git commit, git push 하는 것을 막는다.
REAL=${shq(realGit)}
COMMONS=${shq(commons.join('\n'))}

# 하위 명령 찾기: 전역 옵션을 건너뛰고 처음 나오는 낱말. 값을 따로 받는 옵션은 그 값도 건너뛴다.
sub=""
skip=0
opt=""
dir=""
unsure=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then
    skip=0
    case "$opt" in
      -C) case "$a" in /*) dir="$a" ;; *) dir="\${dir:+$dir/}$a" ;; esac ;;
      --git-dir|--work-tree) unsure=1 ;;
    esac
    continue
  fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source) skip=1; opt="$a" ;;
    --git-dir=*|--work-tree=*) unsure=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done

# 사용자의 git 별칭을 풀어 본다 (ci = commit, pu = push 등). 최대 세 번.
n=0
while [ -n "$sub" ] && [ "$sub" != commit ] && [ "$sub" != push ] && [ "$n" -lt 3 ]; do
  # 표준 입력은 넘겨줄 진짜 명령의 것이다. 여기서 읽어 버리면 안 된다.
  alias=$( (cd "\${dir:-.}" 2>/dev/null && "$REAL" config --get "alias.$sub") 2>/dev/null </dev/null ) || break
  [ -n "$alias" ] || break
  case "$alias" in
    '!'*)
      # 셸로 실행되는 별칭: 본문에 commit 이나 push 가 있으면 그것으로 본다.
      case "$alias" in *commit*) sub=commit ;; *push*) sub=push ;; esac
      break ;;
    *) sub=\${alias%% *} ;;
  esac
  n=$((n + 1))
done

# git merge 는 --no-commit 으로만 받는다: 합치기를 마무리하는 커밋은 사용자가 한다 (--continue 도 커밋을 만든다).
if [ "$sub" = merge ]; then
  mergeok=0
  for a in "$@"; do case "$a" in --no-commit|--abort|--quit) mergeok=1 ;; esac; done
  [ "$mergeok" = 1 ] || sub=merge-commit
fi

case "$sub" in
  commit|push|merge-commit)
    # 어느 저장소에 대한 것인지 본다. 이 워크스페이스의 저장소가 아니면 막지 않는다.
    target=""
    if [ "$unsure" = 0 ]; then
      target=$( (cd "\${dir:-.}" 2>/dev/null && "$REAL" rev-parse --path-format=absolute --git-common-dir) 2>/dev/null </dev/null )
      [ -n "$target" ] && target=$( (cd "$target" 2>/dev/null && pwd -P) )
    fi
    # --git-dir, --work-tree 로 저장소를 따로 가리킨 경우는 판단할 수 없어 막는다.
    blocked=0
    if [ "$unsure" = 1 ]; then
      blocked=1
    elif [ -n "$target" ]; then
      while IFS= read -r c; do
        [ "$target" = "$c" ] && blocked=1
      done <<DURE_COMMONS
$COMMONS
DURE_COMMONS
    fi
    if [ "$blocked" = 1 ]; then
      if [ "$sub" = merge-commit ]; then
        printf '%s\\n' \\
          '[두레] git merge 는 --no-commit --no-ff 로만 한다 (예: git merge --no-commit --no-ff 브랜치). 충돌을 풀고 git add 까지 하라.' \\
          '합치기를 마무리하는 커밋은 사용자가 두레의 커밋 창에서 한다: commit_draft_save 로 메시지를 저장하고 알려라.' >&2
      elif [ "$sub" = commit ]; then
        printf '%s\\n' \\
          '[두레] git commit 은 사용자가 두레 화면에서 직접 한다. 에이전트는 커밋하지 않는다.' \\
          '지금 할 일: 커밋 메시지를 commit_draft_save 도구로 저장하고, 사용자에게 커밋할 준비가 됐다고 알려라.' >&2
      else
        printf '%s\\n' '[두레] git push 는 사용자가 두레 화면에서 직접 한다. 에이전트는 push 하지 않는다.' >&2
      fi
      exit 1
    fi ;;
esac

exec "$REAL" "$@"
`;
}
