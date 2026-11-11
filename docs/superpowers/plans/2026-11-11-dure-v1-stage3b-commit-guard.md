# 두레 버전 1, 3B단계 (커밋 창) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트는 커밋 메시지만 자동으로 써 두고, 사용자가 두레 화면의 커밋 창에서 그 메시지를 고친 뒤 커밋과 push 를 직접 실행한다. 에이전트의 `git commit`, `git push` 는 실제로 막는다.

**Architecture:** 에이전트 터미널의 `PATH` 맨 앞에 두레의 `git` 대리 실행 파일을 둔다. 하위 명령이 `commit` 또는 `push` 면 거절하고, 나머지는 진짜 git 으로 넘긴다. 에이전트는 `commit_draft_save` 도구로 커밋 메시지 초안을 두레에 저장한다. 사용자는 워크스페이스 화면의 커밋 창에서 바뀐 파일과 초안을 보고, 메시지를 고치고, "커밋" 과 "push" 를 누른다. 실제 git 실행은 코어가 사용자의 로그인 셸 환경으로 한다.

**Tech Stack:** 1~3A단계와 같음. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-11-11-dure-v1-design.md` (7.8). 실험 근거: `docs/superpowers/findings/2026-11-11-agent-wiring.md` 9번.

## 사용자가 정한 것 (2026-11-11)

- 커밋 메시지는 에이전트가 자동으로 작성한다.
- 사용자가 그 메시지를 고칠 수 있는 창을 보여준다.
- 커밋과 push 는 사용자가 화면에서 직접 한다.

이로써 설계 7.8 의 "에이전트에게 맡기기" 버튼은 만들지 않는다. 에이전트는 커밋·push 를 하지 않는다.

## 이 계획이 정한 것

1. **에이전트의 `git commit`, `git push` 는 항상 거절된다.** 허용하는 길이 없으므로 대리 실행 파일은 두레에 묻지 않고 그 자리에서 거절한다(두레가 꺼져 있어도 같다).
2. **커밋 창은 바뀐 파일 목록을 보여주고 체크로 넣을 파일을 고르게 한다.** 기본은 전부 체크. 파일별 변경 내용(diff)은 보여주지 않는다(diff 뷰는 버전 1 범위 밖). 추가·삭제 줄 수만 보여준다.
3. **push 버튼 옆에 어디로 나가는지(원격 주소와 브랜치)를 보여준다.** `origin` 이 없으면 push 버튼은 꺼지고 이유를 보인다.
4. **커밋이나 push 가 끝나면 에이전트에게 알린다.** 두레의 알림 메시지로 전달한다(3A단계의 전달 통로).
5. **막는 대상은 `commit` 과 `push` 두 하위 명령뿐이다.** `merge`, `rebase`, `cherry-pick` 처럼 커밋을 만드는 다른 명령과 `/usr/bin/git` 직접 호출은 막지 않는다. 실수와 지침 이탈을 막는 장치이지 보안 경계가 아니다(설계 7.8).
6. **배포는 다루지 않는다.** 지침으로만 건다.

## Global Constraints

- 1~3A단계 계획의 Global Constraints 전부.
- 대리 실행 파일은 에이전트 터미널에만 건다. 사용자가 여는 셸 탭과 코어가 실행하는 git 에는 걸지 않는다.
- 대리 실행 파일은 `<dataDir>/workspaces/<id>/bin/git` 에만 둔다. 사용자 저장소와 전역 git 설정을 건드리지 않는다.
- `commit`, `push` 가 아닌 git 명령은 지연 없이 진짜 git 으로 넘긴다. 인자, 종료 코드, 표준 입출력을 그대로 전한다.
- 코어가 실행하는 커밋은 사용자의 git 설정(이름, 메일, 서명, hook)을 그대로 따른다. `--no-verify` 같은 우회 옵션을 붙이지 않는다.
- push 는 사용자가 버튼을 누를 때만, 그 워크스페이스 브랜치를 `origin` 으로만 보낸다. 강제 push 를 하지 않는다. 원격을 추가하거나 바꾸지 않는다.
- 커밋 메시지와 파일 경로는 `execFile` 인자로만 넘긴다. 셸을 거치지 않는다.
- 화면에 보이는 글은 한국어다. git 이 낸 오류 글은 원문 그대로 보여준다.
- 작업은 `feat/dure-v1-commit` 브랜치(`.worktrees/commit`)에서 한다. 검증용 인스턴스는 데이터 폴더를 분리해 띄우고 프로젝트 이름에 "검증용" 을 넣는다.
- 검증에 쓰는 저장소는 임시 저장소이고, push 확인은 임시 폴더의 bare 저장소를 `origin` 으로 삼는다. 실제 원격으로는 아무것도 보내지 않는다.

## Review Focus

1. 에이전트가 `git -C <경로> commit`, `git -c user.name=x commit`, `git --no-pager push` 처럼 전역 옵션을 앞에 붙인다. 하위 명령을 놓쳐 통과시키면 안 된다. (Task 2)
2. 커밋 메시지에 따옴표, 줄바꿈, `$()`, `-` 로 시작하는 줄이 있다. 셸에서 실행되거나 git 옵션으로 읽히면 안 된다. (Task 1)
3. 파일 이름에 공백, 한글, 따옴표가 있거나 파일이 지워졌거나 이름이 바뀌었다. 목록에 맞게 보이고 고른 것만 커밋돼야 한다. (Task 1)
4. 커밋이 실패한다(pre-commit hook 거절, 서명 실패, 바뀐 것 없음). 초안과 사용자가 고친 메시지가 사라지면 안 되고 git 의 오류가 그대로 보여야 한다. (Task 3, Task 4)
5. push 가 거절된다(원격이 앞서 있음, 인증 실패, 원격 없음). 강제로 밀지 않고 git 의 오류를 그대로 보여야 한다. (Task 1, Task 4)

## File Structure

```
src/shared/types.ts                 CommitDraft, ChangedFile, CommitState, CommitResult
src/core/db.ts                      마이그레이션 4 (commit_drafts)
src/core/git.ts                     changedFiles, commitFiles, remoteUrl, aheadCount, push
src/core/commitDrafts.ts            CommitDraftStore
src/core/commitService.ts           CommitService (화면이 쓰는 상태 조회, 커밋, push, 에이전트 알림)
src/core/agents/gitShim.ts          대리 실행 파일 내용
src/core/agents/launch.ts           files 에 bin/git, env 에 PATH
src/core/mcp/tools/commit.ts        commit_draft_save
src/core/agents/instructions.ts     커밋 관련 지침
src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts   commit.* 채널, 'commit' 주제
src/renderer/components/CommitDialog.tsx   커밋 창
src/renderer/components/WorkspaceView.tsx  "커밋" 버튼
tests/core/gitCommit.test.ts, commitDrafts.test.ts, gitShim.test.ts, commitService.test.ts
```

---

### Task 1: git 동작과 초안 저장

**Files:**
- Modify: `src/shared/types.ts`, `src/core/db.ts`, `src/core/git.ts`
- Create: `src/core/commitDrafts.ts`
- Test: `tests/core/gitCommit.test.ts`, `tests/core/commitDrafts.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export interface ChangedFile {
  path: string;                 // 저장소 기준 경로
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  from?: string;                // 이름이 바뀐 경우 옛 경로
  added: number | null;         // 추가된 줄 수. 이진 파일이나 추적 안 된 파일은 null
  removed: number | null;
}
export interface CommitDraft { workspaceId: string; message: string; updatedAt: number }
export interface CommitResult { hash: string; subject: string }

// src/core/git.ts — Git 에 추가
changedFiles(path: string): Promise<ChangedFile[]>;
commitFiles(o: { path: string; files: string[]; message: string }): Promise<CommitResult>;
remoteUrl(path: string, remote?: string): Promise<string | null>;          // 없으면 null
aheadCount(path: string, branch: string): Promise<number | null>;          // origin/<branch> 보다 앞선 커밋 수. 원격 브랜치가 없으면 null
push(o: { path: string; branch: string }): Promise<string>;                // git 의 출력 글

// src/core/commitDrafts.ts
export class CommitDraftStore extends EventEmitter {
  constructor(db);
  save(workspaceId: string, message: string): CommitDraft;   // 워크스페이스마다 하나, 덮어쓴다. 빈 글이면 오류
  get(workspaceId: string): CommitDraft | undefined;
  clear(workspaceId: string): void;
  // 이벤트: 'changed' (workspaceId)
}
```

규칙:

- `changedFiles` 는 `git status --porcelain=v1 -z --untracked-files=all` 로 읽는다(`-z` 라 공백·한글·따옴표가 든 이름이 깨지지 않는다). 줄 수는 `git diff --numstat -z HEAD` 로 읽는다.
- `commitFiles`: `files` 가 비면 오류 `커밋할 파일을 고르세요.`. 메시지는 앞뒤 공백을 떼고 비면 오류 `커밋 메시지를 입력하세요.`. 실행 순서는 `git add -A -- <files…>` 다음 `git commit -m <message> -- <files…>`. 경로 앞에 항상 `--` 를 둔다. 메시지는 `-m` 의 값으로만 넘긴다. 이름이 바뀐 파일은 옛 경로도 함께 넘긴다.
- `commitFiles` 가 실패하면 `GitError`(git 의 표준 오류 포함)를 던진다. 스테이징은 되돌리지 않는다(사용자가 터미널에서 본 상태와 같아야 한다).
- `push` 는 `git push -u origin <branch>` 를 실행한다. `--force` 계열을 붙이지 않는다. 실패하면 `GitError`.
- 초안은 워크스페이스가 지워지면 함께 지워진다(`ON DELETE CASCADE`).

- [ ] **Step 1: 실패하는 테스트 작성.** 실제 임시 저장소를 쓴다. push 는 임시 bare 저장소를 `origin` 으로 삼는다.

```ts
test('changedFiles: 수정, 추가, 삭제, 추적 안 됨을 구분하고 줄 수를 준다', async () => {});
test('changedFiles: 이름 바뀜은 renamed 이고 from 에 옛 경로', async () => {});
test('changedFiles: 공백·한글·따옴표가 든 파일 이름이 그대로 나온다', async () => { /* '새 문서 "초안".md' */ });
test('changedFiles: 바뀐 것이 없으면 빈 목록', async () => {});
test('commitFiles: 고른 파일만 커밋되고 나머지는 바뀐 채로 남는다', async () => {});
test('commitFiles: 메시지의 따옴표, 줄바꿈, $(…), - 로 시작하는 줄이 글자 그대로 커밋 메시지가 된다', async () => {
  // message = '-m 처럼 보이는 제목\n\n--amend\n$(touch /tmp/dure-x) "따옴표"' → git log -1 --format=%B 와 같고 /tmp/dure-x 는 없다
});
test('commitFiles: - 로 시작하는 파일 이름도 옵션으로 읽히지 않는다', async () => { /* '-rf.txt' */ });
test('commitFiles: 삭제한 파일과 이름 바꾼 파일을 커밋할 수 있다', async () => {});
test('commitFiles: 빈 파일 목록과 빈 메시지는 오류', async () => {});
test('commitFiles: pre-commit hook 이 거절하면 GitError 이고 hook 의 출력이 stderr 에 있다', async () => {});
test('commitFiles: 결과는 짧은 해시와 제목 줄', async () => {});
test('remoteUrl: origin 이 없으면 null, 있으면 주소', async () => {});
test('push: bare 원격으로 보내고 aheadCount 가 0 이 된다', async () => {});
test('push: 원격이 앞서 있으면 GitError 이고 강제로 밀지 않는다', async () => { /* 원격의 커밋이 그대로 */ });
test('aheadCount: 원격 브랜치가 없으면 null, 한 번 push 한 뒤 커밋하면 1', async () => {});
test('CommitDraftStore: save 는 덮어쓰고 빈 글은 오류, 워크스페이스를 지우면 사라진다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add changed files, commit, push and commit drafts`

---

### Task 2: git 대리 실행 파일

**Files:**
- Create: `src/core/agents/gitShim.ts`
- Modify: `src/core/agents/launch.ts`, `src/core/workspaceService.ts`
- Test: `tests/core/gitShim.test.ts`, `tests/core/launch.test.ts`, `tests/core/workspaceService.test.ts`

**Interfaces:**
- Produces:

```ts
// src/core/agents/gitShim.ts
export function gitShimScript(realGit: string): string;
// AgentLaunchInput 에 추가: realGit?: string; basePath: string
```

대리 실행 파일(`/bin/sh` 스크립트)의 동작:

1. 인자를 앞에서부터 훑어 하위 명령을 찾는다. `-` 로 시작하는 인자는 건너뛴다. 값을 따로 받는 전역 옵션(`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--config-env`, `--exec-path`)은 `=` 없이 쓰였으면 다음 인자도 함께 건너뛴다. 처음 만나는 `-` 로 시작하지 않는 인자가 하위 명령이다. 원래 인자는 바꾸지 않는다.
2. 하위 명령이 `commit` 이면 다음을 표준 오류에 쓰고 `exit 1`:

```
[두레] git commit 은 사용자가 두레 화면에서 직접 한다. 에이전트는 커밋하지 않는다.
지금 할 일: 커밋 메시지를 commit_draft_save 도구로 저장하고, 사용자에게 커밋할 준비가 됐다고 알려라.
```

3. 하위 명령이 `push` 면 다음을 쓰고 `exit 1`:

```
[두레] git push 는 사용자가 두레 화면에서 직접 한다. 에이전트는 push 하지 않는다.
```

4. 그 밖에는 `exec <realGit> "$@"`.

- `realGit` 은 `baseEnv.PATH` 에서 찾은 `git` 의 절대 경로다. 못 찾으면 대리 실행 파일을 걸지 않는다(에이전트는 뜬다).
- 실행 정보: `files` 에 `configDir/bin/git`(권한 `0o700`)을 더하고 `env.PATH` 를 `<configDir>/bin:<basePath>` 로 준다. 두 에이전트 모두 같다.
- 사용자 셸 탭(`openShell`)의 환경은 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성.** 스크립트를 실제로 실행한다. 가짜 `realGit` 은 받은 인자를 한 줄에 하나씩 찍는다.

```ts
test.each([
  [['commit', '-m', 'a'], 'deny'], [['-C', '/x y', 'commit'], 'deny'], [['-c', 'user.name=x', 'commit'], 'deny'],
  [['--no-pager', 'commit'], 'deny'], [['--git-dir=/x', 'push'], 'deny'], [['--git-dir', '/x', 'push', 'origin'], 'deny'],
  [['status'], 'pass'], [['log', '--grep', 'commit'], 'pass'], [['-C', 'commit', 'status'], 'pass'], [['add', 'commit'], 'pass'], [[], 'pass'],
])('%j → %s', async () => {});
test('거절하면 진짜 git 은 실행되지 않고 표준 오류에 안내문, 종료 코드 1', async () => {});
test('넘길 때 인자가 그대로다: 공백, 따옴표, 줄바꿈, $(…)', async () => {});
test('넘길 때 진짜 git 의 종료 코드와 표준 입력이 그대로 전해진다', async () => {});
test('두 에이전트 모두 files 에 bin/git(0o700)이 있고 env.PATH 가 그 폴더로 시작한다', () => {});
test('realGit 이 없으면 대리 실행 파일과 PATH 를 걸지 않는다', () => {});
test('에이전트 터미널에서 git commit 은 거절되고 git status 는 된다 (가짜 에이전트가 git 을 실행)', async () => {});
test('사용자 셸 탭의 PATH 에는 대리 실행 파일 폴더가 없다', async () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): block git commit and push in agent terminals`

---

### Task 3: 커밋 서비스, 에이전트 도구, 지침

**Files:**
- Create: `src/core/commitService.ts`, `src/core/mcp/tools/commit.ts`
- Modify: `src/core/agents/instructions.ts`, `src/core/index.ts`, `src/core/mcp/server.ts`
- Test: `tests/core/commitService.test.ts`, `tests/core/launch.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Git`, `CommitDraftStore`; 3A단계의 `MessageService.send`(보내는 쪽 `system`).
- Produces:

```ts
// src/shared/types.ts
export interface CommitState {
  branch: string;
  files: ChangedFile[];
  draft: CommitDraft | null;
  remoteUrl: string | null;         // origin 주소
  ahead: number | null;             // 아직 push 하지 않은 커밋 수 (원격 브랜치가 없으면 null)
}
// src/core/commitService.ts
export class CommitService extends EventEmitter {
  state(workspaceId: string): Promise<CommitState>;
  commit(workspaceId: string, i: { files: string[]; message: string }): Promise<CommitResult>;
  push(workspaceId: string): Promise<string>;
  // 이벤트: 'changed' (workspaceId)
}
```

- `commit` 이 성공하면 초안을 지우고, 에이전트에게 두레의 알림을 보낸다: `사용자가 커밋했다: <해시> <제목>`. 실패하면 초안을 그대로 둔다.
- `push` 가 성공하면 알림을 보낸다: `사용자가 push 했다: <브랜치> → origin`. `origin` 이 없으면 오류 `원격 저장소(origin)가 없습니다.`.
- 알림은 그 워크스페이스로 가는 "두레 알림" 스레드 하나에 쌓는다(없으면 만들고, 있으면 그 스레드를 쓴다).
- 도구 `commit_draft_save({ message })`: 초안을 저장하고 `{ saved: true }` 를 돌려준다.
- 지침의 마지막 문장(`커밋 메시지는 작성만 하고 …`)을 다음으로 바꾼다.

```
커밋과 push 는 사용자가 두레 화면에서 직접 한다. 너는 하지 않는다. 두레가 git commit, git push 를 막고 있다.
- 커밋할 만한 단위의 작업이 끝나면 커밋 메시지를 써서 commit_draft_save 도구로 저장하라. 사용자가 그 메시지를 고쳐서 커밋한다. 작업이 더 진행되면 다시 저장해 덮어써라.
- 사용자가 커밋하거나 push 하면 두레가 알려준다.
- 배포는 실행하지 마라. 사용자 몫 TODO 로 남겨라.
- 막힌 것을 다른 방법으로 우회하지 마라.
```

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('state: 브랜치, 바뀐 파일, 초안, 원격 주소, 앞선 커밋 수를 한 번에 준다', async () => {});
test('commit: 성공하면 초안이 지워지고 에이전트에게 "사용자가 커밋했다: …" 알림이 간다', async () => {});
test('commit: 실패하면(pre-commit 거절) 초안이 그대로 남고 오류가 전해진다', async () => {});
test('push: origin 이 없으면 오류', async () => {});
test('push: 성공하면 알림이 가고 state 의 ahead 가 0 이 된다', async () => {});
test('알림은 같은 "두레 알림" 스레드에 쌓인다', async () => {});
test('commit_draft_save 도구가 초안을 저장하고 changed 가 난다', async () => {});
test('지침에 커밋·push 문단이 있다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add commit service, draft tool and instructions`

---

### Task 4: 커밋 창

**Files:**
- Create: `src/renderer/components/CommitDialog.tsx`
- Modify: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/components/WorkspaceView.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `tests/core/ipcContract.test.ts`, `tests/renderer/commitView.test.ts`

**Interfaces:**
- Produces: `DureApi.commit.state(workspaceId)`, `commit.run(workspaceId, { files, message })`, `commit.push(workspaceId)`; `ChangeTopic` 에 `'commit'`. `src/renderer/commitView.ts`: `statusLabel(status)`(추가, 수정, 삭제, 이름 바뀜, 새 파일), `pushHint(state)`(push 버튼 옆에 보일 한 줄).

화면 규칙 (TODO 패널의 디자인 말씨를 따른다):

- 워크스페이스 화면 머리에 "커밋" 버튼. 에이전트가 초안을 저장해 둔 것이 있으면 버튼에 점을 찍고 툴팁 `에이전트가 커밋 메시지를 써 두었습니다`.
- 버튼을 누르면 커밋 창이 뜬다.
  - 위: 브랜치 이름.
  - 바뀐 파일 목록: 체크박스, 상태 글자(`statusLabel`), 경로(이름 바뀜은 `옛 경로 → 새 경로`), 줄 수(`+12 −3`, 없으면 비움). 맨 위에 "전체 선택" 체크. 기본은 전부 체크. 바뀐 파일이 없으면 `커밋할 변경이 없습니다.`.
  - 메시지 입력칸(여러 줄, 고정폭, 높이 8줄 이상). 초안이 있으면 채워 두고 위에 `에이전트가 작성 · <시각>` 을 보인다. 사용자가 고칠 수 있다. 초안이 없으면 비어 있고 안내 `에이전트에게 "커밋 메시지 써 줘" 라고 하거나 직접 쓰세요.`.
  - "커밋" 버튼: 체크한 파일이 없거나 메시지가 비면 꺼진다. 실행 중에는 꺼지고 `커밋하는 중…`.
  - 성공하면 창 안에 `커밋했습니다: <해시> <제목>` 을 보이고 목록과 메시지를 새로 읽는다.
  - 실패하면 git 의 오류를 그대로(줄바꿈 유지) 보이고, 사용자가 쓴 메시지는 그대로 둔다.
  - push 구역: 한 줄 안내(`pushHint`)와 "push" 버튼.
    - `origin` 없음: 버튼 꺼짐, `원격 저장소(origin)가 없어 push 할 수 없습니다.`
    - 보낼 커밋 없음(`ahead` 0): 버튼 꺼짐, `push 할 커밋이 없습니다.`
    - 그 밖: `<브랜치> → <원격 주소>` 와 보낼 커밋 수(`ahead` 가 null 이면 `처음 push 하는 브랜치입니다`).
    - 성공하면 git 의 출력을, 실패하면 오류를 그대로 보인다.
- 창은 Esc 와 바깥 클릭으로 닫힌다. 닫아도 사용자가 고친 메시지는 그 워크스페이스에 대해 남아 있다가 다시 열면 보인다(앱을 끄면 사라진다). 에이전트가 초안을 새로 저장하면 그것으로 바뀐다.
- `onChanged('commit')` 을 받으면 열려 있는 창의 목록과 초안을 다시 읽는다. 사용자가 메시지를 고치는 중이면 메시지는 덮어쓰지 않고 `에이전트가 메시지를 새로 썼습니다` 와 "불러오기" 를 보인다.

- [ ] **Step 1: 실패하는 테스트 작성.** `IPC_CHANNELS` 에 새 채널. `statusLabel` 다섯 가지. `pushHint` 네 경우.
- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사·빌드 통과 확인.**
- [ ] **Step 3: 화면 확인 (에이전트 없이).** 검증용 인스턴스에서 임시 저장소(bare 원격 연결)로: 바뀐 파일 목록, 초안이 채워진 창, 메시지 고쳐 커밋, 커밋 결과, push 안내와 push, 실패(pre-commit 거절) 화면을 스크린샷으로 본다. 디자인을 스스로 비평하고 고친다.
- [ ] **Step 4: 커밋.** `feat(renderer): add commit dialog`

---

### Task 5: 실제 에이전트로 확인

- [ ] **Step 1: 준비.** 검증용 인스턴스에 임시 저장소(임시 bare 원격 연결)로 프로젝트 "검증용 (커밋 창)" 과 Claude Code 워크스페이스 하나를 만든다.
- [ ] **Step 2: 장면.** 화면을 읽어 확인한 뒤에만 입력한다. 결과를 항목별로 사용자에게 보고한다.
  1. "README 에 한 줄 추가하고 커밋해" 라고 시킨다 → 에이전트의 `git commit` 이 거절되는가. `git log` 에 새 커밋이 없는가.
  2. 에이전트가 커밋 메시지를 초안으로 저장하는가. "커밋" 버튼에 점이 찍히는가.
  3. 커밋 창에 바뀐 파일과 초안이 보이는가. 메시지를 고쳐 "커밋" 을 누르면 그 메시지로 커밋되는가.
  4. 에이전트가 "사용자가 커밋했다" 알림을 받는가.
  5. "push" 를 누르면 임시 원격에 올라가는가.
  6. 에이전트가 우회를 시도하는가(`/usr/bin/git commit` 등). 시도했다면 그대로 기록한다.
  7. 저장소에 두레가 남긴 파일이 없는가. 사용자 셸 탭에서 `git commit` 이 막히지 않는가.
- [ ] **Step 3: 설계 문서 갱신.** 7.8 을 사용자가 정한 방식으로 고쳐 쓴다("에이전트에게 맡기기" 삭제, 커밋 창, 한계).
- [ ] **Step 4: 커밋.** `docs: record stage 3b decisions and verification`
