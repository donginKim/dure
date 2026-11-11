# 두레 버전 1, 2단계 (TODO 패널) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트가 세운 계획이 워크스페이스 옆 TODO 패널에 늘 보이고, 사용자가 항목을 고치거나 완료 체크하면 에이전트의 다음 단계부터 반영되게 한다.

**Architecture:** TODO의 원본은 코어의 SQLite다. 에이전트는 두레 MCP 도구로 읽고 쓰고, 화면은 IPC로 읽고 쓴다. 사용자 변경은 워크스페이스별 "미전달 변경"으로 쌓였다가 Claude Code의 hook이 코어의 `/hook` 주소를 부를 때 에이전트에게 끼워 넣어진다. 같은 hook 호출로 워크스페이스 상태(작업 중, 쉬는 중, 사용자 기다림)도 갱신한다.

**Tech Stack:** 1단계와 같음. 새 의존성 없음. hook 스크립트는 macOS 기본 `curl` 을 쓴다.

**Spec:** `docs/superpowers/specs/2026-11-11-dure-v1-design.md` (7.2, 7.4). 실험 근거: `docs/superpowers/findings/2026-11-11-agent-wiring.md`.

이 계획이 다루지 않는 것: 프로젝트 범위 TODO를 에이전트에게 전달하는 것과 워크스페이스 항목을 프로젝트 항목에 딸리게 하는 것(둘 다 조율 에이전트가 생기는 4단계), 커밋 메시지 초안과 `git` 대리 실행 파일(3단계), 채팅 보기(별도 설계).

## 설계 문서에 없어 이 계획이 정한 것

1. **쉬는 에이전트는 TODO 수정만으로 깨우지 않는다.** 미전달 변경은 다음 프롬프트 때 함께 전달된다. 바로 반영시키고 싶으면 패널의 "에이전트에게 알리기" 버튼을 누른다. 이 버튼은 hook 신호로 쉬는 중임이 확인된 Claude Code 워크스페이스에서만 켜진다(터미널에 써 넣는 방식이라 상태를 모르면 위험하다).
2. **Codex는 hook 실험이 끝나지 않아 끼워 넣기를 하지 않는다.** 대신 `todo_list` 도구가 미전달 변경을 함께 돌려주고, 지침이 "단계마다 `todo_list` 를 먼저 확인하라" 고 시킨다. 이 경로는 Claude Code에도 똑같이 있다. Codex 워크스페이스의 상태는 지금처럼 "쉬는 중/꺼짐" 만 구분한다.
3. **워크스페이스 에이전트는 자기 워크스페이스의 항목만 고칠 수 있다.** 프로젝트 범위 항목은 읽기만 한다.
4. **순서 바꾸기는 위·아래 버튼이다.** 끌어서 옮기기는 하지 않는다.

## Global Constraints

- 1단계 계획의 Global Constraints 전부(`src/core` 는 electron 을 import하지 않음, 사용자 저장소와 전역 설정에 쓰지 않음, `execFile` 인자 배열 등).
- 사용자가 고친 항목을 에이전트가 덮어쓰지 못한다: 에이전트의 수정·삭제는 자기가 마지막으로 읽은 `rev` 를 함께 내야 하고, 다르면 거절된다.
- 사용자에게 보이는 글과 에이전트에게 전달하는 글은 한국어다. 에이전트에게 전달하는 글은 `[두레]` 로 시작한다.
- hook 스크립트와 설정 파일은 `<dataDir>/workspaces/<id>/` 에만 쓴다. 토큰이 든 파일은 권한 `0600`(스크립트는 `0700`).
- hook 이 실패하거나 두레가 꺼져 있어도 에이전트의 동작을 막지 않는다(스크립트는 항상 종료 코드 0, 출력 없음).
- 작업은 `feat/dure-v1-todo` 브랜치(저장소 안 `.worktrees/todo` worktree)에서 한다. 띄워 둔 앱을 건드리지 않기 위해서다. 검증용 인스턴스는 `DURE_DATA_DIR`, `DURE_WORKTREE_ROOT` 로 데이터 폴더를 분리해 띄운다.
- 실제 에이전트를 쓰는 확인은 Task 5의 손 확인 한 번뿐이다. 화면을 읽지 않고 터미널에 입력을 보내지 않는다.

## Review Focus

1. 사용자가 항목을 고친 직후 에이전트가 옛 `rev` 로 같은 항목을 고친다. 거절되고 사용자 값이 남아야 한다. (Task 1, Task 3)
2. 에이전트가 응답을 끝내는 순간(Stop)에 미전달 변경이 있다. 끝내지 않고 이어서 반영해야 하고, 같은 변경이 두 번 전달되면 안 된다. (Task 2)
3. 두레가 꺼져 있거나 주소가 바뀐 뒤 에이전트가 hook 을 부른다. 에이전트가 멈추거나 오류를 쏟으면 안 된다. (Task 2)
4. 사용자가 제목에 따옴표, 줄바꿈, `</script>` 같은 글자를 넣는다. hook 응답 JSON 과 화면이 깨지면 안 된다. (Task 1, Task 2)
5. 워크스페이스를 지운다. 그 TODO 와 미전달 변경이 남아 다른 곳에 전달되면 안 된다. (Task 1)

## File Structure

```
src/shared/types.ts                 Todo, TodoStatus, TodoAssignee 추가
src/core/db.ts                      마이그레이션 2 (todos, todo_pending)
src/core/todos.ts                   TodoService (저장, 충돌 규칙, 미전달 변경)
src/core/hooks.ts                   handleHook (상태 전이, 끼워 넣을 응답 만들기)
src/core/mcp/server.ts              /hook/<event> 경로, McpDeps 에 todos
src/core/mcp/tools/todo.ts          todo_list, todo_add, todo_update, todo_remove
src/core/agents/launch.ts           Claude 용 settings.json, hook.sh
src/core/agents/instructions.ts     TODO 사용 지침
src/core/workspaceService.ts        nudge
src/core/index.ts                   Core.todos, 워크스페이스 삭제 시 TODO 정리
src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts   todos.* 채널, 'todos' 주제
src/renderer/components/TodoPanel.tsx    패널 (워크스페이스용, 프로젝트용)
src/renderer/todoView.ts            화면용 순수 함수
tests/core/todos.test.ts, hooks.test.ts, todoTools.test.ts, tests/renderer/todoView.test.ts
```

---

### Task 1: TODO 저장과 규칙

**Files:**
- Modify: `src/shared/types.ts`, `src/core/db.ts`, `src/core/index.ts`, `src/core/workspaceService.ts`
- Create: `src/core/todos.ts`
- Test: `tests/core/todos.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export type TodoStatus = 'todo' | 'doing' | 'done' | 'cancelled';
export type TodoAssignee = 'agent' | 'user';
export type Actor = 'agent' | 'user';
export interface Todo {
  id: string; projectId: string; workspaceId: string | null;   // null 이면 프로젝트 범위
  title: string; detail: string; status: TodoStatus; assignee: TodoAssignee;
  position: number; rev: number; updatedBy: Actor; createdAt: number; updatedAt: number;
}

// src/core/todos.ts
export class TodoConflictError extends Error { current: Todo }
export type TodoPatch = Partial<Pick<Todo, 'title' | 'detail' | 'status' | 'assignee'>>;
export type By = { actor: 'user' } | { actor: 'agent'; rev: number };
export class TodoService extends EventEmitter {
  constructor(db: Database.Database);
  listProject(projectId: string): Todo[];        // 프로젝트 범위 + 모든 워크스페이스 항목
  listWorkspace(workspaceId: string): Todo[];
  get(id: string): Todo | undefined;
  add(i: { projectId: string; workspaceId?: string | null; title: string; detail?: string; assignee?: TodoAssignee; status?: TodoStatus }, actor: Actor): Todo;
  update(id: string, patch: TodoPatch, by: By): Todo;
  remove(id: string, by: By): void;
  move(id: string, direction: 'up' | 'down'): void;      // 사용자만 쓴다
  pendingCount(workspaceId: string): number;
  takePending(workspaceId: string): string[];            // 미전달 변경을 돌려주고 전달됨으로 지운다
  removeWorkspace(workspaceId: string): void;            // 항목과 미전달 변경을 모두 지운다
  // 이벤트: 'changed' (projectId)
}
export function pendingMessage(lines: string[]): string;
```

규칙:

- 정렬은 같은 범위 안에서 `position` 오름차순. `add` 는 그 범위의 맨 끝에 넣는다. `move` 는 같은 범위의 이웃과 자리를 바꾸고, 끝에서는 아무 일도 하지 않는다.
- 값이 실제로 바뀐 수정마다 `rev` 가 1 오른다. 새 항목은 `rev` 1. 제목은 앞뒤 공백을 떼고, 비면 오류.
- `by.actor === 'agent'` 인 `update`/`remove` 는 `by.rev` 가 현재 `rev` 와 다르면 `TodoConflictError`(현재 항목 포함)를 던지고 아무것도 바꾸지 않는다.
- 미전달 변경은 **사용자**가 **워크스페이스 범위** 항목을 바꿨을 때만 쌓인다. 한 줄 문구는 정확히 다음과 같다.
  - 추가: `추가됨: "<제목>"`, 담당이 사용자면 뒤에 ` (사용자 몫)`
  - 제목: `제목 바뀜: "<옛 제목>" → "<새 제목>"`
  - 설명: `설명 바뀜: "<제목>"`
  - 상태가 `done` 으로: `사용자가 직접 완료함: "<제목>"`
  - 상태가 `cancelled` 로: `취소됨: "<제목>"`
  - 상태가 `todo` 또는 `doing` 으로: `다시 열림: "<제목>"`
  - 담당: `담당 바뀜: "<제목>" → 사용자` 또는 `→ 에이전트`
  - 삭제: `삭제됨: "<제목>"`
  - 순서: `순서 바뀜: "<제목>" 이(가) <n>번째로`
- 한 번의 `update` 가 여러 필드를 바꾸면 위 순서(제목, 설명, 상태, 담당)로 여러 줄이 쌓인다.
- `pendingMessage(lines)` 는 `[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:\n- <줄>\n- <줄>\n현재 목록은 todo_list 도구로 확인하라.` 를 만든다.
- `WorkspaceService.remove` 는 `todos.removeWorkspace(id)` 를 부른다. 프로젝트 삭제는 DB 의 `ON DELETE CASCADE` 로 정리한다.
- `Core` 에 `todos: TodoService` 를 더한다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('add 는 범위의 맨 끝에 넣고 rev 는 1', () => {});
test('listWorkspace 는 그 워크스페이스 항목만, listProject 는 프로젝트 범위와 모든 워크스페이스 항목', () => {});
test('사용자 update 는 rev 를 올리고 updatedBy 가 user', () => {});
test('값이 같으면 rev 가 오르지 않고 미전달 변경도 없다', () => {});
test('에이전트가 옛 rev 로 고치면 TodoConflictError 이고 사용자 값이 남는다', () => {
  // 사용자가 제목을 '로그인 API' → '로그인 API v2' 로 바꾼 뒤, 에이전트가 rev 1 로 status 'done' 시도
  // → 오류의 current.title === '로그인 API v2', 항목의 status 는 그대로 'todo'
});
test('에이전트가 맞는 rev 로 고치면 통과하고 미전달 변경은 쌓이지 않는다', () => {});
test('에이전트의 remove 도 rev 가 다르면 거절된다', () => {});
test.each([
  ['add', '추가됨: "배포" (사용자 몫)'],
  ['title', '제목 바뀜: "A" → "B"'],
  ['done', '사용자가 직접 완료함: "A"'],
  ['cancelled', '취소됨: "A"'],
  ['reopen', '다시 열림: "A"'],
  ['assignee', '담당 바뀜: "A" → 사용자'],
  ['remove', '삭제됨: "A"'],
  ['move', '순서 바뀜: "B" 이(가) 1번째로'],
])('사용자 변경 %s 의 미전달 문구', () => {});
test('프로젝트 범위 항목의 사용자 변경은 미전달 변경을 만들지 않는다', () => {});
test('takePending 은 한 번만 돌려준다', () => { /* 두 번째 호출은 [] , pendingCount 0 */ });
test('제목의 따옴표·줄바꿈·</script> 가 그대로 보존된다', () => {});
test('move 는 이웃과 자리를 바꾸고 끝에서는 그대로', () => {});
test('removeWorkspace 뒤 그 항목과 미전달 변경이 없다', () => {});
test('프로젝트를 지우면 그 TODO 도 지워진다', () => {});
test('pendingMessage 형식', () => {
  expect(pendingMessage(['추가됨: "A"', '삭제됨: "B"'])).toBe(
    '[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:\n- 추가됨: "A"\n- 삭제됨: "B"\n현재 목록은 todo_list 도구로 확인하라.');
});
test('워크스페이스를 지우면 서비스가 그 TODO 를 정리한다', async () => { /* createCore 로 확인 */ });
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add todo store with conflict rule and pending user changes`

---

### Task 2: hook 주소, 상태 전이, Claude Code 연결

**Files:**
- Create: `src/core/hooks.ts`
- Modify: `src/core/mcp/server.ts`, `src/core/agents/launch.ts`, `src/core/index.ts`
- Test: `tests/core/hooks.test.ts`, `tests/core/launch.test.ts`, `tests/core/mcp.test.ts`

**Interfaces:**
- Consumes: `TodoService.takePending`, `pendingCount`, `pendingMessage`, `WorkspaceStore.update`.
- Produces:

```ts
// src/core/hooks.ts
export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification';
export interface HookDeps { workspaces: WorkspaceStore; todos: TodoService; onStatus(workspaceId: string): void }
/** 상태를 갱신하고, hook 이 표준 출력으로 내보낼 글(JSON 또는 빈 글)을 돌려준다. */
export function handleHook(deps: HookDeps, workspace: Workspace, event: string, payload: unknown): string;

// src/core/mcp/server.ts — McpDeps 에 추가
//   todos: TodoService; onHook(workspace: Workspace, event: string, payload: unknown): string;
// 경로: POST /hook/<event>  (토큰 인증은 /mcp 와 같음) → 200, 본문은 onHook 의 반환값

// src/core/agents/launch.ts — AgentLaunchInput 에 hookUrl: string 추가 (예: http://127.0.0.1:5555/hook)
```

동작 표:

| 이벤트 | 상태 | 응답 본문 |
|---|---|---|
| `SessionStart` | `idle` | 빈 글 |
| `UserPromptSubmit` | `working` | 미전달 변경이 있으면 `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<pendingMessage>"}}`, 없으면 빈 글 |
| `PreToolUse` | `working` | 빈 글 |
| `PostToolUse` | `working` | 미전달 변경이 있으면 `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<pendingMessage>"}}`, 없으면 빈 글 |
| `Stop` | 미전달 변경이 있으면 그대로 `working`, 없으면 `idle` | 있으면 `{"decision":"block","reason":"<pendingMessage>"}`, 없으면 빈 글 |
| `Notification` | 승인 요청이면 `waiting_user`, 아니면 그대로 | 빈 글 |
| 그 밖 | 그대로 | 빈 글 |

- 응답 JSON 은 `JSON.stringify` 로 만든다(문자열을 이어 붙이지 않는다).
- 상태가 실제로 바뀔 때만 `onStatus` 를 부른다. 코어는 이를 `service` 의 `changed` 로 내보낸다.
- `stopped` 상태인 워크스페이스에 온 hook 은 상태를 바꾸지 않는다(에이전트 터미널이 없는데 살아나면 안 된다). 응답은 표대로 한다.
- Claude Code 실행 정보: `files` 에 `configDir/settings.json` 과 `configDir/hook.sh` 를 더하고 인자에 `--settings <configDir/settings.json>` 를 더한다. `hook.sh` 는 실행 권한이 있어야 하므로 `AgentLaunch.files` 항목에 `mode?: number` 를 더하고 `hook.sh` 는 `0o700`, 나머지는 `0o600` 으로 쓴다.

```sh
#!/bin/sh
# 두레에 상태를 알리고, 두레가 돌려준 글을 그대로 내보낸다. 실패해도 에이전트를 막지 않는다.
curl -s -m 5 -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" --data-binary @- "<hookUrl>/$1" 2>/dev/null
exit 0
```

`settings.json` 은 여섯 이벤트 각각에 `[{"matcher":"","hooks":[{"type":"command","command":"<hook.sh 경로를 작은따옴표로 감싼 것> <이벤트>"}]}]` 를 건다(경로에 공백이 있다).

- Codex 실행 정보는 바꾸지 않는다.

- [ ] **Step 1: Notification 본문 확인.** `spikes/` 의 echo 서버로 Claude Code 를 `--permission-mode acceptEdits` 로 띄워 승인 창이 뜨는 명령을 시키고, `Notification` hook 이 받은 JSON 전체를 `spikes/out/notification.json` 에 남긴다. 승인 요청을 가려낼 필드와 값을 결과 문서 7번 행에 적고, 아래 테스트의 `<승인 요청 본문>` 을 그 실제 JSON 으로 채운다. 승인 창은 Esc 로 닫는다(화면을 읽고 확인한 뒤).
- [ ] **Step 2: 실패하는 테스트 작성.**

```ts
// hooks.test.ts
test.each([['SessionStart', 'idle'], ['UserPromptSubmit', 'working'], ['PreToolUse', 'working'], ['PostToolUse', 'working']])
  ('%s 는 상태를 %s 로 바꾼다', () => {});
test('Stop: 미전달 변경이 없으면 idle 이고 빈 글', () => {});
test('Stop: 미전달 변경이 있으면 block 응답이고 상태는 working 그대로, 두 번째 Stop 은 빈 글에 idle', () => {});
test('PostToolUse: 미전달 변경을 additionalContext 로 돌려주고 한 번만 돌려준다', () => {
  // JSON.parse(out).hookSpecificOutput.additionalContext === pendingMessage([...])
});
test('제목에 따옴표·줄바꿈·</script> 가 있어도 응답이 올바른 JSON 이다', () => {});
test('Notification: 승인 요청이면 waiting_user, 다른 알림이면 상태 그대로', () => {});
test('waiting_user 에서 PostToolUse 가 오면 working 으로 돌아온다', () => {});
test('stopped 인 워크스페이스는 hook 이 와도 stopped 그대로', () => {});
test('상태가 바뀔 때만 onStatus 가 불린다', () => {});
test('모르는 이벤트는 빈 글이고 아무것도 바꾸지 않는다', () => {});

// mcp.test.ts
test('POST /hook/Stop 은 토큰이 맞으면 200 과 onHook 의 반환값을 돌려준다', async () => {});
test('POST /hook/Stop 은 토큰이 없으면 401', async () => {});
test('hook 본문이 JSON 이 아니어도 200 이다', async () => {});

// launch.test.ts
test('claude: settings.json 이 여섯 이벤트에 hook.sh 를 걸고 인자에 --settings 가 있다', () => {});
test('claude: hook.sh 는 0o700 이고 토큰과 hookUrl 을 담으며 항상 exit 0 으로 끝난다', () => {});
test('claude: 공백이 든 configDir 도 hook 명령에서 작은따옴표로 감싸진다', () => {});
test('codex: 실행 정보는 1단계와 같다', () => {});

// workspaceService.test.ts
test('hook.sh 를 직접 실행하면 코어가 상태를 바꾼다', async () => {
  // startAgent(가짜 claude) → configDir/hook.sh 를 execFile 로 'PreToolUse' 인자와 '{}' 입력으로 실행 → status 'working'
});
test('두레가 꺼진 뒤 hook.sh 를 실행해도 종료 코드 0 이고 출력이 없다', async () => {});
```

- [ ] **Step 3: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 4: 커밋.** `feat(core): add hook endpoint driving workspace status and todo delivery`

---

### Task 3: 에이전트용 TODO 도구와 지침

**Files:**
- Create: `src/core/mcp/tools/todo.ts`
- Modify: `src/core/agents/instructions.ts`, `src/core/index.ts`
- Test: `tests/core/todoTools.test.ts`, `tests/core/launch.test.ts`

**Interfaces:**
- Consumes: `TodoService`, `McpContext`.
- Produces: `export const todoTools: ToolBundle`. 도구:

| 도구 | 인자 | 결과(JSON 글) |
|---|---|---|
| `todo_list` | 없음 | `{ items: [{ id, title, detail, status, assignee, rev, scope }], userChanges: string[] }`. `scope` 는 `workspace` 또는 `project`. `userChanges` 는 `takePending` 결과(가져가면 전달된 것으로 친다) |
| `todo_add` | `title`, `detail?`, `assignee?`, `status?` | 만든 항목 |
| `todo_update` | `id`, `rev`, `title?`, `detail?`, `status?`, `assignee?` | 고친 항목 |
| `todo_remove` | `id`, `rev` | `{ removed: true }` |

- `todo_add` 는 항상 호출한 워크스페이스 범위에 만든다.
- `todo_update`/`todo_remove` 는 대상이 호출한 워크스페이스의 항목이 아니면 `isError: true` 와 글 `이 워크스페이스의 항목만 고칠 수 있다.` 를 돌려준다.
- 충돌이면 `isError: true` 와 글 `사용자가 이 항목을 먼저 바꿨다. 현재 값: <현재 항목 JSON>. todo_list 로 다시 읽고 판단하라.` 를 돌려준다.
- 지침(`baseInstructions`)에 다음 문단을 더한다.

```
계획과 진행 상황은 네 내부 TODO 도구가 아니라 두레의 TODO 로 관리하라. 사용자가 두레 화면에서 그 목록을 보고 직접 고친다.
- 일을 시작할 때 todo_add 로 단계를 적고, 진행에 따라 todo_update 로 status 를 doing, done 으로 바꿔라.
- 단계를 시작하기 전에 todo_list 로 목록과 userChanges 를 확인하라. 사용자가 직접 끝낸 항목은 건너뛰고, 바뀐 내용을 따르라.
- 사용자가 해야 하는 일(커밋, push, 배포 등)은 assignee 를 user 로 적어라.
```

- [ ] **Step 1: 실패하는 테스트 작성** (SDK `Client` 로 실제 접속).

```ts
test('도구 목록에 todo_list, todo_add, todo_update, todo_remove 가 있다', async () => {});
test('todo_add 는 호출한 워크스페이스 범위에 만들고 updatedBy 는 agent', async () => {});
test('todo_list 는 자기 워크스페이스 항목과 프로젝트 범위 항목만 준다', async () => { /* 다른 워크스페이스 항목은 없다 */ });
test('todo_list 는 사용자 변경을 userChanges 로 주고 두 번째 호출에서는 비어 있다', async () => {});
test('todo_update 는 맞는 rev 면 통과한다', async () => {});
test('todo_update 는 옛 rev 면 isError 이고 현재 값을 알려준다', async () => {});
test('다른 워크스페이스의 항목과 프로젝트 범위 항목은 고칠 수 없다', async () => {});
test('todo_remove 는 맞는 rev 면 지운다', async () => {});
test('지침에 두레 TODO 사용 문단이 있다', () => { /* '두레의 TODO 로 관리하라', 'todo_list', 'assignee 를 user 로' */ });
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add todo tools for agents`

---

### Task 4: IPC 와 "에이전트에게 알리기"

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/core/workspaceService.ts`
- Test: `tests/core/ipcContract.test.ts`, `tests/core/workspaceService.test.ts`

**Interfaces:**
- Produces:

```ts
// DureApi 에 추가
todos: {
  list(projectId: string): Promise<Todo[]>;
  add(i: { projectId: string; workspaceId: string | null; title: string; assignee?: TodoAssignee }): Promise<Todo>;
  update(id: string, patch: TodoPatch): Promise<Todo>;
  remove(id: string): Promise<void>;
  move(id: string, direction: 'up' | 'down'): Promise<void>;
  pending(projectId: string): Promise<Record<string, number>>;   // 워크스페이스 id → 미전달 변경 수
  nudge(workspaceId: string): Promise<void>;
};
// ChangeTopic 에 'todos' 추가. IPC 로 들어온 변경은 모두 actor 'user' 다.

// WorkspaceService
canNudge(id: string): boolean;          // claude 이고, status 가 idle 이고, 에이전트 터미널이 살아 있고, 미전달 변경이 있다
nudge(id: string): Promise<void>;       // 미전달 변경을 가져와 에이전트 터미널에 써 넣는다
```

- `nudge` 는 `canNudge` 가 거짓이면 오류 `에이전트가 쉬는 중일 때만 알릴 수 있습니다.` 를 던지고 미전달 변경을 건드리지 않는다.
- 써 넣는 방식(실험 03): `\x1b[200~` + `pendingMessage(...)` + `\x1b[201~` 를 쓰고 400ms 뒤 `\r`. 쓰기 직전에 상태를 `working` 으로 바꾼다(같은 내용을 두 번 누르지 못하게).
- `WorkspaceServiceDeps` 에 `todos` 를 더한다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('IPC_CHANNELS 에 todos.list, add, update, remove, move, pending, nudge 가 있다', () => {});
test('nudge: 쉬는 중인 claude 에 미전달 변경이 있으면 터미널에 [두레] 글이 들어가고 미전달 변경이 비워진다', async () => {
  // 가짜 claude 는 `cat` 처럼 입력을 그대로 출력 → 버퍼에 '[두레] 사용자가 TODO를 바꿨다' 와 '추가됨: "A"'
});
test('nudge: 상태가 working 이면 오류이고 미전달 변경이 남는다', async () => {});
test('nudge: 에이전트가 꺼져 있으면 오류', async () => {});
test('nudge: codex 워크스페이스는 오류', async () => {});
test('nudge: 미전달 변경이 없으면 오류', async () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사 통과 확인.**
- [ ] **Step 3: 커밋.** `feat: expose todos over ipc and add idle-only nudge`

---

### Task 5: TODO 패널

**Files:**
- Create: `src/renderer/todoView.ts`, `src/renderer/components/TodoPanel.tsx`
- Modify: `src/renderer/components/WorkspaceView.tsx`, `src/renderer/components/ProjectView.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/todoView.test.ts`

**Interfaces:**
- Produces:

```ts
// src/renderer/todoView.ts
export interface TodoGroup { key: string; title: string; workspaceId: string | null; items: Todo[] }
export function groupTodos(todos: Todo[], workspaces: Workspace[]): TodoGroup[];   // 첫 묶음은 '프로젝트' (workspaceId null), 이어서 워크스페이스 생성 순
export function progress(items: Todo[]): { done: number; total: number };          // cancelled 는 total 에서 뺀다
export const TODO_STATUS_LABEL: Record<TodoStatus, string>;                         // 할 일, 진행 중, 완료, 취소
```

화면 규칙:

- **워크스페이스 화면**: 터미널 오른쪽에 폭 340px 의 TODO 패널. 머리줄에 "TODO", 진행도(`2/5`), 접기 버튼. 접으면 터미널이 전체 폭을 쓰고 가장자리에 "TODO 2/5" 세로 탭이 남는다. 접힘 여부는 워크스페이스를 오가도 유지한다(앱을 다시 켜면 펼침).
- **프로젝트 화면**: "워크스페이스" 구역 아래에 "TODO" 구역. `groupTodos` 순서대로 묶음을 보여준다.
- 항목 한 줄: 체크박스, 제목, 오른쪽에 표시(진행 중이면 돌아가는 표시와 "진행 중", 담당이 사용자면 "사용자 몫" 표시, 취소면 줄 그은 제목).
  - 체크박스를 켜면 `done`, 끄면 `todo`.
  - 제목을 누르면 그 자리에서 고친다. Enter 로 저장, Esc 로 취소. 빈 제목은 저장하지 않는다.
  - 줄에 마우스를 올리면 버튼이 나온다: 위로, 아래로, 담당 바꾸기(에이전트 ↔ 사용자), 취소/되살리기, 삭제.
  - 설명이 있으면 제목 아래 회색 한 줄(넘치면 말줄임, 마우스를 올리면 전체).
- 담당이 사용자인 항목은 묶음 안에서 "사용자 몫" 소제목 아래 따로 모아 보여준다(순서는 `position`).
- 패널 맨 아래에 추가 입력칸: 글자를 넣고 Enter. 옆의 "사용자 몫" 체크를 켜면 담당이 사용자로 만들어진다.
- 미전달 변경이 있으면 패널 머리줄 아래에 띠: `에이전트에게 아직 전달되지 않은 변경 N건`. 에이전트가 작업 중이면 `다음 단계에 전달됩니다`, 쉬는 중인 Claude Code 면 "에이전트에게 알리기" 버튼, 그 밖에는 `다음 프롬프트 때 전달됩니다`.
- 사용자가 준 글은 React 가 이스케이프한 글로만 그린다(`dangerouslySetInnerHTML` 금지).
- `onChanged('todos')` 와 `'workspaces'` 를 받으면 다시 읽는다.
- 왼쪽 목록의 워크스페이스 줄 오른쪽에 진행도 `2/5` 를 작게 보여준다(항목이 있을 때만).

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('groupTodos: 프로젝트 묶음이 먼저, 이어서 워크스페이스 생성 순, 항목 없는 워크스페이스도 묶음으로 나온다', () => {});
test('groupTodos: 묶음 안은 position 순', () => {});
test('progress: done 과 total, cancelled 는 total 에서 뺀다', () => { /* [done, todo, cancelled] → {done:1,total:2} */ });
test('TODO_STATUS_LABEL', () => { /* { todo:'할 일', doing:'진행 중', done:'완료', cancelled:'취소' } */ });
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사·빌드 통과 확인.**
- [ ] **Step 3: 화면 확인 (에이전트 없이).** 분리된 데이터 폴더로 검증용 인스턴스를 띄워 다음을 화면에서 읽어 확인하고 스크린샷을 본다: 항목 추가, 제목 고치기, 완료 체크, 담당 바꾸기, 순서 바꾸기, 삭제, 접기, 프로젝트 화면의 묶음, 제목 `"<b>x</b>"` 가 글자 그대로 보이는 것.
- [ ] **Step 4: 실제 에이전트로 확인 (Claude Code 한 세션).** 결과를 항목별로 사용자에게 보고한다.
  1. "README 에 한 줄 추가하는 일을 3단계 계획으로 세워 두레 TODO 에 적고 진행해" → 패널에 항목이 생기고 상태가 바뀐다. 왼쪽 목록의 상태가 "작업 중" 이 됐다가 "쉬는 중" 으로 돌아온다.
  2. 작업 도중 패널에서 남은 항목 하나를 완료 체크 → 에이전트가 그 항목을 건너뛴다(터미널 출력에서 확인).
  3. 에이전트가 쉬는 중일 때 항목을 하나 추가 → 띠에 "1건" 과 "에이전트에게 알리기" 가 보인다 → 누르면 에이전트가 깨어나 반영한다.
  4. 사용자가 제목을 고친 항목을 에이전트가 옛 `rev` 로 고치려 하면 거절되고 사용자 제목이 남는다(1~3 중에 자연히 생기지 않으면 생략하고 테스트로만 확인했다고 적는다).
  5. 승인 창이 뜨는 명령을 시키면 상태가 "사용자 기다림" 이 된다.
- [ ] **Step 5: 설계 문서 갱신.** 7.2 에 "설계 문서에 없어 이 계획이 정한 것" 네 가지를 옮겨 적는다.
- [ ] **Step 6: 커밋.** `feat(renderer): add todo panel`
