# 두레 버전 1, 3B단계 (커밋·push 차단, 커밋 메시지 초안) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트가 사용자 허락 없이 `git commit`, `git push` 를 실행하지 못하게 실제로 막고, 사용자가 TODO 에서 "에이전트에게 맡기기" 를 누른 일만 허용한다. 에이전트가 쓴 커밋 메시지는 초안으로 저장해 화면에서 보고 복사할 수 있게 한다.

**Architecture:** 에이전트 터미널의 `PATH` 맨 앞에 두레의 `git` 대리 실행 파일을 둔다. 이 파일은 하위 명령이 `commit` 또는 `push` 일 때만 코어의 `/guard` 주소에 허용 여부를 묻고, 나머지는 진짜 git 으로 그대로 넘긴다. 허용의 근거는 TODO 항목이다: 동작이 표시된(`commit`/`push`) 항목을 사용자가 "에이전트에게 맡기기" 로 넘긴 동안만 허용된다. 커밋 메시지 초안은 워크스페이스마다 하나씩 SQLite 에 둔다.

**Tech Stack:** 1~3A단계와 같음. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-11-11-dure-v1-design.md` (7.8). 실험 근거: `docs/superpowers/findings/2026-11-11-agent-wiring.md` 9번(에이전트가 실행한 `git` 이 `PATH` 앞의 대리 실행 파일을 탄다).

이 계획이 다루지 않는 것: 배포 차단(명령이 프로젝트마다 달라 지침과 TODO 로만 다룬다, 설계 7.8). 채팅 보기(3C단계).

## 설계 문서에 없어 이 계획이 정한 것

1. **무엇을 맡겼는지는 TODO 항목의 "동작" 표시로 안다.** 항목에 `commit` 또는 `push` 표시를 달 수 있다. 에이전트가 사용자 몫으로 "커밋", "push" 항목을 만들 때 이 표시를 단다. 표시가 있는 사용자 몫 항목에만 "에이전트에게 맡기기" 버튼이 나온다. 사용자가 손으로 만든 항목에도 표시를 달 수 있다.
2. **허용은 버튼으로만 생긴다.** 에이전트가 항목의 담당을 스스로 에이전트로 바꾸거나 표시 달린 항목을 새로 만들어도 허용되지 않는다. 사용자가 터미널에 "커밋해" 라고 입력한 것도 허용이 아니다(그때는 에이전트가 거절 안내를 받고, 사용자가 버튼을 누르면 된다).
3. **허용이 사라지는 때:** 그 항목이 완료되거나 취소되거나 삭제될 때, 사용자가 담당을 다시 자기로 돌릴 때.
4. **두레에 물을 수 없으면 막는다.** 두레가 꺼졌거나 응답이 없으면 `commit`, `push` 는 거절된다. 다른 git 명령은 영향받지 않는다.
5. **막는 대상은 `commit` 과 `push` 두 하위 명령뿐이다.** `merge`, `rebase`, `cherry-pick`, `revert`, `am` 처럼 커밋을 만드는 다른 명령은 막지 않는다. 설계 7.8 의 범위 그대로이고, 이 한계를 설계 문서에 적는다.

## Global Constraints

- 1~3A단계 계획의 Global Constraints 전부.
- 대리 실행 파일은 에이전트 터미널에만 건다. 사용자가 여는 셸 탭에는 걸지 않는다.
- 대리 실행 파일과 그 설정은 `<dataDir>/workspaces/<id>/` 에만 둔다. 사용자 저장소와 전역 git 설정을 건드리지 않는다.
- `commit`, `push` 가 아닌 git 명령은 두레에 묻지 않고 지연 없이 진짜 git 으로 넘긴다. 종료 코드, 표준 입출력, 인자를 그대로 전한다.
- 거절할 때는 표준 오류에 이유와 다음에 할 일을 한국어로 적고 종료 코드 1 로 끝낸다. 글은 `[두레]` 로 시작한다.
- 토큰은 프로세스 인자에 넣지 않는다(헤더 파일 `auth.hdr` 재사용).
- 작업은 `feat/dure-v1-commit-guard` 브랜치(`.worktrees/commit-guard`)에서 한다. 검증용 인스턴스는 데이터 폴더를 분리해 띄우고 프로젝트 이름에 "검증용" 을 넣는다.
- 실제 에이전트를 쓰는 것은 Task 5 의 손 확인 한 번(Claude Code 한 세션)이다. 검증용 저장소는 원격이 없는 임시 저장소라 `push` 는 실제로 나가지 않는다.

## Review Focus

1. 에이전트가 `git -C <다른 경로> commit`, `git -c user.name=x commit`, `git --no-pager commit` 처럼 전역 옵션을 앞에 붙인다. 하위 명령을 놓쳐 통과시키면 안 된다. (Task 2)
2. 에이전트가 TODO 도구로 스스로 허용을 만들려 한다: 표시 달린 항목을 에이전트 몫으로 새로 만들기, 사용자 몫 항목의 담당을 에이전트로 바꾸기. 허용되면 안 된다. (Task 1, Task 3)
3. 맡긴 항목이 완료된 뒤 에이전트가 다시 커밋한다. 거절돼야 한다. (Task 1)
4. 커밋 메시지나 경로에 공백, 따옴표, 줄바꿈, `$()` 가 있다. 대리 실행 파일을 지나며 인자가 깨지거나 셸에서 실행되면 안 된다. (Task 2)
5. 두레가 꺼진 상태에서 에이전트가 `git status`, `git diff` 를 실행한다. 평소처럼 돼야 한다. `git commit` 은 거절돼야 한다. (Task 2)

## File Structure

```
src/shared/types.ts                 Todo.action, Todo.granted, TodoAction, CommitDraft
src/core/db.ts                      마이그레이션 4 (todos.action, todos.granted, commit_drafts)
src/core/todos.ts                   action 다루기, delegate, 허용 판정
src/core/guard.ts                   gitDecision (허용 여부와 거절 문구)
src/core/commitDrafts.ts            CommitDraftStore
src/core/agents/gitShim.ts          대리 실행 파일 내용 만들기, 하위 명령 가려내기
src/core/agents/launch.ts           files 에 bin/git, env 에 PATH
src/core/mcp/server.ts              /guard/git/<하위 명령> 경로
src/core/mcp/tools/todo.ts          todo_add 의 action, commit_draft_save
src/core/agents/instructions.ts     거절됐을 때의 행동 지침
src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts   todos.delegate, todos.setAction, commitDrafts.get
src/renderer/components/TodoPanel.tsx    맡기기 버튼, 동작 표시, 커밋 메시지 초안
tests/core/guard.test.ts, gitShim.test.ts, commitDrafts.test.ts
```

---

### Task 1: 동작 표시, 맡기기, 허용 판정

**Files:**
- Modify: `src/shared/types.ts`, `src/core/db.ts`, `src/core/todos.ts`, `src/core/index.ts`
- Create: `src/core/guard.ts`
- Test: `tests/core/todos.test.ts`, `tests/core/guard.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export type TodoAction = 'commit' | 'push';
// Todo 에 추가: action: TodoAction | null; granted: boolean;

// src/core/todos.ts
add(i: { ...기존; action?: TodoAction | null }, actor: Actor): Todo;   // granted 는 항상 false 로 만들어진다
setAction(id: string, action: TodoAction | null): Todo;               // 사용자만 쓴다. 표시를 바꾸면 granted 는 false
delegate(id: string): Todo;                                           // 사용자만 쓴다
hasGrant(workspaceId: string, action: TodoAction): boolean;

// src/core/guard.ts
export type GitDecision = { allow: true } | { allow: false; message: string };
export function gitDecision(todos: TodoService, workspaceId: string, sub: string): GitDecision;
```

규칙:

- `delegate(id)`: 항목에 `action` 이 있고, 워크스페이스 범위이고, 상태가 `todo` 또는 `doing` 이어야 한다. 아니면 오류. 담당을 `agent` 로, `granted` 를 true 로 바꾸고 `rev` 를 올린다. 미전달 변경에 다음 줄을 쌓는다: `맡김: "<제목>". 이제 git <commit|push> 을 실행해도 된다. 끝나면 이 항목을 done 으로 바꿔라.`
- `granted` 가 false 로 돌아가는 때: 상태가 `done` 또는 `cancelled` 가 될 때, 담당이 `user` 로 바뀔 때(누가 바꾸든), `setAction` 으로 표시가 바뀔 때.
- `update` 로는 `granted` 를 올릴 수 없다. 에이전트가 담당을 `agent` 로 바꿔도 `granted` 는 그대로 false 다.
- `hasGrant(workspaceId, action)`: 그 워크스페이스에 `action` 이 같고 `granted` 이고 담당이 `agent` 이고 상태가 `todo` 또는 `doing` 인 항목이 하나라도 있으면 true.
- `gitDecision`: `sub` 가 `commit`, `push` 가 아니면 `{ allow: true }`. 맞으면 `hasGrant` 로 판정. 거절 문구는 정확히:

```
[두레] git <sub> 은 사용자가 맡겨야 실행할 수 있다.
지금 할 일: 커밋 메시지를 commit_draft_save 로 저장하고, "<커밋|push>" 를 사용자 몫 TODO 로 남겨라 (todo_add 에 assignee "user", action "<sub>").
사용자가 두레 화면에서 그 항목의 "에이전트에게 맡기기" 를 누르면 다시 실행할 수 있다.
```

  `push` 일 때는 둘째 줄이 `지금 할 일: "push" 를 사용자 몫 TODO 로 남겨라 (todo_add 에 assignee "user", action "push").` 다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
// todos.test.ts
test('add 에 action 을 주면 표시가 달리고 granted 는 false', () => {});
test('delegate: 담당이 agent, granted true 가 되고 미전달 변경에 맡김 문구가 쌓인다', () => {});
test('delegate: action 없는 항목, 프로젝트 범위 항목, 완료된 항목은 오류', () => {});
test('에이전트가 update 로 담당을 agent 로 바꿔도 granted 는 false', () => {});
test('에이전트가 action 달린 항목을 agent 몫으로 만들어도 granted 는 false', () => {});
test.each(['done', 'cancelled'])('맡긴 항목이 %s 가 되면 granted 가 꺼진다', () => {});
test('맡긴 항목의 담당을 user 로 돌리면 granted 가 꺼진다', () => {});
test('setAction 으로 표시를 바꾸면 granted 가 꺼진다', () => {});
test('hasGrant: 맡긴 commit 항목이 있으면 commit 만 true, push 는 false, 다른 워크스페이스는 false', () => {});

// guard.test.ts
test('commit, push 가 아니면 항상 허용', () => { /* status, diff, log, add, 빈 글 */ });
test('맡긴 항목이 없으면 commit 거절이고 문구가 정확하다', () => {});
test('맡긴 항목이 없으면 push 거절이고 문구가 정확하다', () => {});
test('commit 을 맡기면 commit 허용, 항목을 done 으로 바꾸면 다시 거절', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add todo actions, delegation and git guard decision`

---

### Task 2: git 대리 실행 파일과 /guard 주소

**Files:**
- Create: `src/core/agents/gitShim.ts`
- Modify: `src/core/agents/launch.ts`, `src/core/mcp/server.ts`, `src/core/workspaceService.ts`, `src/core/index.ts`
- Test: `tests/core/gitShim.test.ts`, `tests/core/launch.test.ts`, `tests/core/mcp.test.ts`, `tests/core/workspaceService.test.ts`

**Interfaces:**
- Consumes: `gitDecision`.
- Produces:

```ts
// src/core/agents/gitShim.ts
export function gitShimScript(o: { realGit: string; guardUrl: string; authHeaderFile: string }): string;
// src/core/mcp/server.ts — McpDeps 에 추가: onGuard(workspace: Workspace, sub: string): GitDecision
// 경로: POST /guard/git/<sub> (토큰 인증) → 200. 본문은 허용이면 "allow", 거절이면 "deny\n<거절 문구>"
// RunningMcpServer.guardUrl = http://127.0.0.1:<port>/guard
// AgentLaunchInput 에 추가: guardUrl: string; realGit: string; basePath: string
```

대리 실행 파일의 동작 (`/bin/sh` 스크립트):

1. 인자를 훑어 하위 명령을 찾는다. 앞에서부터, `-` 로 시작하는 인자는 건너뛴다. 그중 값을 따로 받는 전역 옵션(`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--config-env`, `--exec-path` 는 `=` 없이 쓰였을 때)은 다음 인자도 함께 건너뛴다. 처음 만나는 `-` 로 시작하지 않는 인자가 하위 명령이다. 인자 자체는 바꾸지 않는다.
2. 하위 명령이 `commit` 도 `push` 도 아니면 `exec <realGit> "$@"`.
3. 맞으면 `curl -sf -m 5 -X POST -H @<authHeaderFile> "<guardUrl>/git/<sub>"` 의 응답을 읽는다. 첫 줄이 `allow` 면 `exec <realGit> "$@"`. 첫 줄이 `deny` 면 나머지 줄을 표준 오류에 쓰고 `exit 1`. curl 이 실패했거나 응답이 그 밖이면 `[두레] 두레에 연결할 수 없어 git <sub> 을 막았다. 두레 앱이 켜져 있는지 사용자에게 확인을 부탁하라.` 를 표준 오류에 쓰고 `exit 1`.

- `realGit` 은 `baseEnv.PATH` 에서 찾은 `git` 의 절대 경로다(대리 실행 파일 폴더는 제외). 못 찾으면 대리 실행 파일을 걸지 않는다(에이전트는 뜬다).
- 실행 정보: `files` 에 `configDir/bin/git`(권한 `0o700`)을 더하고, `env.PATH` 를 `<configDir>/bin:<basePath>` 로 준다. 두 에이전트 모두 같다.
- 사용자 셸 탭(`openShell`)의 환경은 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성.** 대리 실행 파일은 실제로 실행해 확인한다: 임시 폴더에 인자를 한 줄에 하나씩 찍는 가짜 `realGit` 을 두고, 임시 HTTP 서버가 `/guard` 를 흉내 낸다.

```ts
// gitShim.test.ts
test.each([
  [['status'], 'status'], [['-C', '/x y', 'commit', '-m', 'a'], 'commit'], [['-c', 'user.name=x', 'commit'], 'commit'],
  [['--no-pager', 'commit'], 'commit'], [['--git-dir=/x', 'push'], 'push'], [['--git-dir', '/x', 'push', 'origin'], 'push'],
  [['log', '--grep', 'commit'], 'log'], [['-C', 'commit', 'status'], 'status'], [[], ''],
])('하위 명령 찾기 %j → %s', async () => { /* 가드 서버가 받은 sub 또는 "묻지 않음" 으로 확인 */ });
test('commit 이 아니면 두레에 묻지 않고 진짜 git 으로 넘긴다 (인자, 종료 코드, 표준 입력 그대로)', async () => {});
test('허용되면 진짜 git 이 인자 그대로 실행된다: 공백, 따옴표, 줄바꿈, $(…) 가 든 커밋 메시지', async () => {
  // ['commit', '-m', 'fix: "quote" $(touch /tmp/x)\n둘째 줄'] → 가짜 git 이 받은 인자가 글자 그대로, /tmp/x 는 생기지 않는다
});
test('거절되면 진짜 git 은 실행되지 않고 표준 오류에 거절 문구, 종료 코드 1', async () => {});
test('가드 서버가 꺼져 있으면 commit 은 거절(연결 불가 문구), status 는 그대로 된다', async () => {});
test('가드 서버가 401 이나 이상한 본문을 주면 거절한다', async () => {});

// mcp.test.ts
test('POST /guard/git/commit 은 토큰이 맞으면 onGuard 결과를 allow 또는 deny\\n문구 로 돌려준다', async () => {});
test('POST /guard/git/commit 은 토큰이 없으면 401', async () => {});

// launch.test.ts
test('두 에이전트 모두 files 에 bin/git(0o700)이 있고 env.PATH 가 그 폴더로 시작한다', () => {});
test('realGit 이 없으면 대리 실행 파일과 PATH 를 걸지 않는다', () => {});
test('대리 실행 파일 본문에 토큰이 없다', () => {});

// workspaceService.test.ts
test('에이전트 터미널에서 git commit 은 거절되고 git status 는 된다 (가짜 에이전트가 git 을 실행)', async () => {});
test('맡긴 뒤에는 에이전트 터미널의 git commit 이 실제로 커밋을 만든다', async () => {});
test('사용자 셸 탭의 PATH 에는 대리 실행 파일 폴더가 없다', async () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): guard git commit and push in agent terminals`

---

### Task 3: 커밋 메시지 초안, 에이전트 도구와 지침

**Files:**
- Create: `src/core/commitDrafts.ts`
- Modify: `src/core/db.ts`(Task 1 의 마이그레이션에 포함), `src/core/mcp/tools/todo.ts`, `src/core/agents/instructions.ts`, `src/core/index.ts`, `src/core/workspaceService.ts`
- Test: `tests/core/commitDrafts.test.ts`, `tests/core/todoTools.test.ts`, `tests/core/launch.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export interface CommitDraft { workspaceId: string; message: string; updatedAt: number }
// src/core/commitDrafts.ts
export class CommitDraftStore extends EventEmitter {
  constructor(db);
  save(workspaceId: string, message: string): CommitDraft;   // 워크스페이스마다 하나. 다시 저장하면 덮어쓴다. 빈 글이면 오류
  get(workspaceId: string): CommitDraft | undefined;
  clear(workspaceId: string): void;
  // 이벤트: 'changed' (workspaceId)
}
```

- 도구 `commit_draft_save({ message })`: 초안을 저장하고 `{ saved: true }` 를 돌려준다.
- `todo_add` 에 `action?: 'commit' | 'push'` 를 더한다. 결과 항목에 `action` 과 `granted` 를 포함한다. `todo_list` 의 항목에도 포함한다.
- `todo_update` 로는 `action`, `granted` 를 바꿀 수 없다.
- 워크스페이스를 지우면 초안도 지운다.
- 지침의 마지막 문장(`커밋 메시지는 작성만 하고 …`)을 다음으로 바꾼다.

```
커밋과 push 는 사용자가 맡겨야 실행할 수 있다. 두레가 git commit, git push 를 막고 있다.
- 커밋할 내용이 준비되면 커밋 메시지를 commit_draft_save 로 저장하고, todo_add 로 "커밋" 항목을 assignee "user", action "commit" 으로 남겨라. push 가 필요하면 action "push" 항목도 남겨라.
- 사용자가 그 항목을 맡기면 [두레] 로 알려준다. 그때 실행하고, 끝나면 그 항목을 done 으로 바꿔라.
- 배포는 실행하지 마라. 사용자 몫 TODO 로 남겨라.
- 막힌 것을 다른 방법으로 우회하지 마라.
```

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('save 는 덮어쓰고 get 은 마지막 것을 준다, 빈 글은 오류', () => {});
test('워크스페이스를 지우면 초안도 사라진다', async () => {});
test('commit_draft_save 도구가 초안을 저장한다', async () => {});
test('todo_add 에 action 을 주면 항목에 표시가 달리고 granted 는 false', async () => {});
test('todo_update 에 action 이나 granted 를 넣어도 바뀌지 않는다', async () => {});
test('지침에 커밋·push 문단이 있다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add commit drafts and action-tagged todos for agents`

---

### Task 4: 화면

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/components/TodoPanel.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `tests/core/ipcContract.test.ts`, `tests/renderer/todoView.test.ts`

**Interfaces:**
- Produces: `DureApi.todos.delegate(id)`, `DureApi.todos.setAction(id, action)`, `DureApi.commitDrafts.get(workspaceId)`, `ChangeTopic` 에 `'commitDrafts'`. `todoView.ts` 에 `actionLabel(action: TodoAction): string` (`commit` → `커밋`, `push` → `push`), `canDelegate(todo: Todo): boolean`.

화면 규칙 (TODO 패널의 디자인 말씨를 따른다):

- 동작 표시가 달린 항목은 제목 옆에 작은 표시(`커밋`, `push`)를 보인다.
- `canDelegate`: 표시가 있고, 담당이 사용자이고, 상태가 `todo` 또는 `doing` 이고, 워크스페이스 범위. 이때 그 줄에 "에이전트에게 맡기기" 버튼을 늘 보이게 둔다(마우스를 올려야 나오는 것이 아니다).
- 맡긴 항목(`granted`)은 표시 옆에 `맡김` 을 보이고, 줄 동작의 담당 바꾸기 아이콘 툴팁을 `맡기기 취소 (내가 할 일로)` 로 한다.
- 줄 동작에 "동작 표시" 버튼을 하나 더한다: 누를 때마다 없음 → 커밋 → push → 없음 으로 돈다.
- "내가 할 일" 아래에 커밋 메시지 초안이 있으면 블록으로 보인다: 소제목 `커밋 메시지 초안`, 저장 시각, 글(줄바꿈 유지, 고정폭), "복사" 버튼. 복사하면 버튼 글자가 잠깐 `복사됨` 으로 바뀐다.
- 프로젝트 화면의 TODO 묶음에도 표시와 맡기기 버튼이 같게 나온다. 초안은 워크스페이스 화면에만 둔다.

- [ ] **Step 1: 실패하는 테스트 작성.** `IPC_CHANNELS` 에 새 채널, `actionLabel`, `canDelegate` (표시 없음, 에이전트 몫, 완료됨, 프로젝트 범위는 false).
- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사·빌드 통과 확인.**
- [ ] **Step 3: 화면 확인 (에이전트 없이).** 검증용 인스턴스에서 표시 달린 항목, 맡기기 버튼, 맡김 표시, 초안 블록과 복사를 스크린샷으로 본다.
- [ ] **Step 4: 커밋.** `feat(renderer): add delegate button and commit draft to todo panel`

---

### Task 5: 실제 에이전트로 확인

- [ ] **Step 1: 준비.** 검증용 인스턴스에 원격이 없는 임시 저장소로 프로젝트 "검증용 (커밋 차단)" 과 Claude Code 워크스페이스 하나를 만든다.
- [ ] **Step 2: 장면.** 화면을 읽어 확인한 뒤에만 입력한다. 결과를 항목별로 사용자에게 보고한다.
  1. "README 에 한 줄 추가하고 커밋해" 라고 시킨다 → 에이전트의 `git commit` 이 거절되는가(터미널에 `[두레] git commit 은 사용자가 맡겨야` 문구). `git log` 에 새 커밋이 없는가.
  2. 에이전트가 초안을 저장하고 "커밋" 을 사용자 몫, `commit` 표시로 남기는가. 패널에 초안과 맡기기 버튼이 보이는가.
  3. "에이전트에게 맡기기" 를 누른다 → 에이전트가 알림을 받고 커밋하는가. `git log` 에 커밋이 생겼는가. 항목이 완료로 바뀌는가.
  4. 이어서 "한 줄 더 추가하고 커밋해" → 다시 거절되는가(허용이 사라졌는가).
  5. 에이전트가 우회를 시도하는가(`/usr/bin/git commit`, `git merge` 등). 시도했다면 그대로 기록한다(이 계획은 그것을 막지 않는다).
  6. 저장소에 두레가 남긴 파일이 없는가. 사용자 셸 탭에서 `git commit` 이 막히지 않는가.
- [ ] **Step 3: 설계 문서 갱신.** 7.8 에 "설계 문서에 없어 이 계획이 정한 것" 과 확인 결과, 한계(막는 것은 `commit`·`push` 두 명령, 우회 가능)를 적는다.
- [ ] **Step 4: 커밋.** `docs: record stage 3b decisions and verification`
