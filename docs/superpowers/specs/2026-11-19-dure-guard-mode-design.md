# 권한 단계 "삭제만 묻기"

2026-11-19. 브랜치 `feat/dure-guard-mode` (`feat/dure-pins` 위에 쌓음).

## 왜
권한 단계가 셋이다: 승인 필요, 자동 판단, 승인 생략. 자동 판단은 Claude Code 가 위험해 보이는 것을 스스로 골라 물어서 여전히 자주 묻고, 승인 생략은 지우는 것까지 묻지 않는다. 사용자는 그 사이를 원한다: **지우는 것만 묻고 나머지는 묻지 않는다.**

## 목표
- 새 권한 단계 `guard` ("삭제만 묻기"). 순서: 승인 필요, 자동 판단, 삭제만 묻기, 승인 생략.
- 묻는 것 (사용자가 "넓게" 를 골랐다):
  - 파일 지우기: `rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `git clean`, `git rm`, `rsync --delete`, 코드 한 줄로 지우기(`os.remove`, `fs.rm` 등)
  - 데이터 지우기: SQL `DELETE FROM`/`DROP`/`TRUNCATE`, MongoDB `deleteMany`/`drop`, Redis `FLUSHALL`, `dropdb`, `docker ... prune`/`rmi`/`compose down -v`, `kubectl delete`, `terraform destroy`, 클라우드 CLI 의 delete
  - 작업한 것을 날리는 명령: `git reset --hard`, `git checkout -- …`/`git checkout .`/`-f`, `git restore`(스테이징만 푸는 것은 빼고), `git branch -D`, `git stash drop|clear`, `git worktree remove`, `git push --force|--delete`, `git tag -d`
  - 이름에 delete, remove, drop, destroy, purge 가 든 다른 도구 (플러그인이 붙인 MCP 도구)
- 그 밖의 명령 실행, 파일 고치기, 웹 가져오기는 묻지 않는다.

## 하지 않는 것
- 지우는 것을 빠짐없이 잡는 것. 명령의 글자를 보고 가린다: 에이전트가 만든 스크립트 안에서 지우는 것, 처음 보는 도구는 잡지 못한다. 화면의 설명에 이 한계를 적는다.
- 두레가 따로 묻는 것(DB 조회, 내장 브라우저의 주소, 슬랙 읽기, 계획안 승인, 커밋과 push)을 바꾸는 것. 그대로 묻는다.
- Codex. Codex 에는 도구 호출마다 답할 길이 없어, 이 단계를 고르면 자동 판단처럼 돈다.

## 실패로 보는 것
- 두레가 답하지 못했을 때(hook 실패, 시간 초과) 묻지 않고 지나가는 것. 답이 없으면 Claude Code 의 평소 승인으로 돌아가야 한다.
- 에이전트가 사용자에게 묻는 질문(AskUserQuestion)이 저절로 넘어가는 것.

## 방식
- **가. hook 으로 답하기 (고름)**: 두레는 이미 모든 도구 호출을 실행 직전에 받는다 (`PreToolUse` hook, `src/core/hooks.ts`). 에이전트는 `acceptEdits` 로 띄우고, 이 단계의 워크스페이스면 hook 이 "허용" 또는 "묻기" 로 답한다. 채팅 방식과 터미널 방식이 한 곳에서 처리되고, 단계를 바꾸면 다음 도구 호출부터 듣는다. 두레가 답하지 못하면 평소 승인으로 떨어진다.
- 나. Claude Code 의 허용·묻기 규칙을 설정 파일로 주기: 두레 코드가 적지만 규칙이 명령의 앞머리만 보고, 바꾸려면 에이전트를 다시 띄워야 한다.
- 다. 승인 생략으로 띄우고 지우는 것만 hook 으로 막기: 실험에서는 통했지만 두레가 답하지 못하면 아무것도 묻지 않게 된다 (위의 실패).

실험 (2026-11-19, Claude Code 2.1.322, `claude -p`): hook 이 `permissionDecision: "allow"` 로 답하면 기본 모드에서 막히던 `curl` 이 실행된다. `"ask"` 로 답하면 `acceptEdits` 에서 저절로 실행되던 `rm` 이 실행되지 않는다. `mkdir -p d && cd d && rm ../x` 같은 묶은 명령도 전체가 hook 에 온다.

## 동작
- `src/core/agents/guard.ts` 의 `guardDecision(tool, input, worktreePath)` 가 셋 중 하나를 낸다:
  - `ask` (이유와 함께): 위의 지우는 것.
  - `pass` (답하지 않음: 평소 승인): 두레의 도구(`mcp__dure__*`, 이미 허용돼 있다), 사용자에게 묻는 도구(AskUserQuestion, ExitPlanMode), 작업 폴더 밖의 파일을 고치는 것 (내 결정: 사용자의 다른 폴더가 묻지 않고 바뀌지 않게 한다).
  - `allow`: 나머지.
- 승인 창에는 이유가 보인다: "삭제만 묻기: 파일을 지우는 명령입니다 (rm)".
- 조율 에이전트는 권한 단계가 고정이라 해당 없다. 다른 사람에게 받은 일은 지금처럼 승인 필요나 자동 판단으로 만들어진다.
- 화면: 워크스페이스 머리의 선택, 새 워크스페이스 창, 설정의 기본 권한 모드에 "삭제만 묻기" 를 더한다. 설명: "지우거나 작업을 버리는 명령만 묻고 나머지는 묻지 않습니다. 명령의 글자를 보고 가리므로 스크립트 안에서 지우는 것까지는 잡지 못합니다."

## 리뷰 뒤에 바뀐 것 (2026-11-19)
- 띄우는 모드를 `acceptEdits` 에서 `default`(모두 묻기)로 바꿨다. `acceptEdits` 는 작업 폴더 안의 `rm` 을 묻지 않고 실행해서, 두레가 답하지 못하면 지나갔다. 이제 두레가 답하지 못하면 모든 것을 묻는다.
- 명령을 잇는 기호에서 끊어 조각마다 가린다. 한 명령 안의 뒤쪽 것도 본다 (`git restore --staged a && git restore a`).
- 더 묻는 것: 경로를 덮는 `git checkout <가지> <경로>`, `git switch -f`, `git reset --merge`, DB 를 비우는 명령(`prisma migrate reset`, `rails db:drop`, `manage.py flush` 등), `curl -X DELETE`, 내용을 비우는 것(`truncate -s 0`, `> 파일`), 한 줄 코드의 여러 모양.
- 덜 묻는 것: 글을 찾거나 보여 주는 명령 안의 낱말(`grep "rm"`, `which rm`), 패키지 관리자의 rm, `git clean -n`, `git rm --cached`.
- 모르는 도구(플러그인의 MCP 도구)는 이름을 낱말로 가리고, 입력에 든 명령과 질의를 본다. 쓰는 도구가 작업 폴더 밖을 가리키면 평소 승인에 맡긴다.
- 작업 폴더 안의 링크가 밖을 가리키면 밖으로 본다. 계획 모드에서는 답하지 않는다. 2만 자가 넘는 명령은 가리지 않고 묻는다.

## 확인
- `guardDecision` 의 표 시험 (묻는 것, 묻지 않는 것, 헷갈리는 것: `docker run --rm`, `git restore --staged`).
- hook 시험: 이 단계일 때만 답하고, 다른 단계에서는 지금처럼 빈 답.
- 실제 앱: 채팅 방식에서 에이전트에게 파일을 만들고 지우게 해서, 만들 때는 묻지 않고 지울 때만 승인 창이 뜨는지.
