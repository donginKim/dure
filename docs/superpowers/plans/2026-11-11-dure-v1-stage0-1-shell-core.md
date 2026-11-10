# 두레 버전 1, 0·1단계 (확인 실험, 껍데기와 코어) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트와 워크스페이스를 만들고, 워크스페이스마다 git worktree와 터미널을 열어 Claude Code 또는 Codex를 두레 MCP 서버에 연결된 상태로 띄우는 Electron 앱을 만든다. 그 전에 두 에이전트의 연결·전달 방식을 실험으로 확정한다.

**Architecture:** 모든 상태의 원본은 `src/core` 의 두레 코어다. 코어는 Electron을 import하지 않고, SQLite에 상태를 저장하며, localhost HTTP로 MCP 서버를 연다. Electron 메인 프로세스는 코어를 만들어 IPC로 화면(React)에 내보낸다. 에이전트는 node-pty 터미널 안에서 CLI 그대로 돈다.

**Tech Stack:** Electron, electron-vite, TypeScript, React, xterm.js, node-pty, better-sqlite3, `@modelcontextprotocol/sdk`, zod, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-11-dure-v1-design.md`

이 계획이 다루지 않는 것: TODO(2단계), 에이전트 간 대화와 `git` 대리 실행 파일(3단계), 조율 에이전트(4단계), DB(5단계), 요약·자동 이름(6단계). 각각 별도 계획으로 쓴다.

## Global Constraints

- macOS 전용. Windows, Linux 분기 코드를 넣지 않는다.
- `src/core/**` 는 `electron` 을 import하지 않는다.
- 사용자 저장소(등록된 저장소와 그 worktree) 안에는 두레가 어떤 파일도 쓰지 않는다. 설정 파일은 두레 데이터 폴더에만 둔다.
- 사용자 전역 설정 파일(`~/.claude/**`, `~/.codex/**`, `~/.zshrc` 등)을 수정하지 않는다.
- 데이터 폴더: `~/Library/Application Support/dure/`. SQLite 파일은 그 안의 `dure.db`.
- worktree 폴더: `~/dure/worktrees/<프로젝트 slug>/<워크스페이스 slug>`. 브랜치 이름은 `dure/<워크스페이스 slug>`.
- 에이전트 종류는 `claude`, `codex` 둘뿐이다.
- 권한 모드는 `ask`(기본값: 파일 수정 자동 승인, 명령 실행은 승인 필요), `bypass`(승인 생략) 둘뿐이다.
- 에이전트는 커밋 실행, push, 배포를 하지 않는다. 이 단계에서는 실행 시 지침 문구로만 건다.
- 외부 프로그램은 `execFile` 계열로 인자 배열을 넘겨 실행한다. 셸 문자열을 조립하지 않는다(경로에 공백과 한글이 있다. 이 저장소 경로부터 `개인 챌린지` 다).
- 패키지 버전은 설치 시점의 최신 안정판을 쓰고 `pnpm-lock.yaml` 로 고정한다.
- 작업은 `feat/dure-v1-shell` 브랜치에서 한다. `main` 에 직접 커밋하지 않는다. push는 하지 않는다.
- 0단계 실험은 실제 에이전트를 호출하므로 토큰을 쓴다. 실험당 짧은 대화 한두 번이다. 반복 실행이 필요해지면 사용자에게 먼저 알린다.

## Review Focus

1. 등록한 저장소 경로에 공백이나 한글이 있다. worktree 생성과 터미널 실행이 그대로 돼야 한다. (Task 6, Task 7)
2. 앱을 Finder에서 띄워 `PATH` 가 빈약하거나 에이전트 CLI가 설치돼 있지 않다. 터미널이 조용히 죽지 않고 어떤 에이전트가 없는지 알려야 한다. (Task 9)
3. 워크스페이스 생성 도중 `git worktree add` 가 실패한다(기준 브랜치 없음 등). 반쪽짜리 워크스페이스가 목록에 남지 않아야 한다. (Task 9)
4. 사용자가 worktree 폴더를 두레 밖에서 지웠다. 에이전트 시작이 원인을 말하며 실패해야 하고 앱이 죽지 않아야 한다. (Task 9)
5. 터미널이 열린 채 앱을 끈다. 에이전트와 셸 프로세스가 고아로 남지 않아야 한다. (Task 7, Task 10)

## File Structure

```
package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts, .gitignore
src/shared/types.ts          도메인 타입 (Project, Repo, Workspace, TerminalInfo)
src/shared/ipc.ts            화면에 내보내는 DureApi 타입
src/core/db.ts               openDatabase, 마이그레이션
src/core/stores.ts           ProjectStore, RepoStore, WorkspaceStore
src/core/slug.ts             slugify, uniqueSlug
src/core/git.ts              git 명령 감싸기
src/core/shellEnv.ts         로그인 셸 환경 읽기
src/core/pty.ts              PtyManager
src/core/mcp/server.ts       MCP HTTP 서버, 토큰 인증
src/core/mcp/tools/workspace.ts   workspace_whoami 도구
src/core/agents/launch.ts    buildAgentLaunch
src/core/agents/instructions.ts   실행 시 지침 문구
src/core/workspaceService.ts 워크스페이스 생성·삭제, 에이전트·셸 시작
src/core/index.ts            createCore
src/main/index.ts            창, 수명주기
src/main/ipc.ts              DureApi 를 IPC 핸들러로 등록
src/preload/index.ts         window.dure 노출
src/renderer/index.html, main.tsx, App.tsx, styles.css
src/renderer/tree.ts         buildTree (순수 함수)
src/renderer/components/Sidebar.tsx, ProjectView.tsx, WorkspaceView.tsx, TerminalPane.tsx, dialogs.tsx
tests/core/*.test.ts, tests/renderer/tree.test.ts
spikes/lib/harness.mjs, spikes/lib/echo-mcp.mjs, spikes/0N-*.mjs
docs/superpowers/findings/2026-11-11-agent-wiring.md
```

---

### Task 1: 프로젝트 뼈대

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
- Test: `tests/core/smoke.test.ts`, `tests/core/boundary.test.ts`

**Interfaces:**
- Produces: 스크립트 `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm spike <파일>`. 경로 별칭 `@core/*`, `@shared/*`.

- [ ] **Step 1: 준비.** `git switch -c feat/dure-v1-shell`. `pnpm -v` 가 실패하면 사용자에게 `npm install -g pnpm` 실행 승인을 받는다.
- [ ] **Step 2: 의존성 설치.** 런타임: `better-sqlite3 node-pty @modelcontextprotocol/sdk zod react react-dom @xterm/xterm @xterm/addon-fit`. 개발: `electron electron-vite vite @vitejs/plugin-react typescript vitest @electron/rebuild @types/node @types/react @types/react-dom @types/better-sqlite3`. `postinstall` 에 `electron-rebuild -f -w better-sqlite3,node-pty` 를 건다.
- [ ] **Step 3: 스크립트.** 네이티브 모듈이 Electron ABI로 빌드되므로 테스트와 실험도 Electron의 Node로 돌린다.

```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "typecheck": "tsc --noEmit",
  "test": "ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run",
  "spike": "ELECTRON_RUN_AS_NODE=1 electron"
}
```

- [ ] **Step 4: 실패하는 테스트 작성.**

```ts
// tests/core/smoke.test.ts
test('네이티브 모듈이 테스트 런타임에서 로드된다', () => {
  const db = new Database(':memory:');
  expect(db.prepare('select 1 as n').get()).toEqual({ n: 1 });
  expect(typeof pty.spawn).toBe('function');
});

// tests/core/boundary.test.ts
test('src/core 는 electron 을 import하지 않는다', () => {
  // src/core 아래 모든 .ts 를 읽어 /from ['"]electron['"]/ 와 /require\(['"]electron['"]\)/ 가 0건인지 확인
});
```

- [ ] **Step 5: `pnpm test` 실행.** 기대: 둘 다 PASS. ABI 불일치 오류(`NODE_MODULE_VERSION`)가 나면 `pnpm exec electron-rebuild -f` 후 다시 돌린다. 그래도 실패하면 여기서 멈추고 사용자에게 보고한다(테스트 런타임 전략을 바꿔야 한다).
- [ ] **Step 6: 빈 창.** `src/main/index.ts` 는 `contextIsolation: true`, `nodeIntegration: false` 인 창 하나를 띄우고, `App.tsx` 는 글자 "두레" 만 그린다. `.gitignore`: `node_modules`, `out`, `dist`, `spikes/out`.
- [ ] **Step 7: 확인.** `pnpm dev` 로 "두레" 창이 뜬다. `pnpm typecheck` 통과.
- [ ] **Step 8: 커밋.** `chore: scaffold electron app with core test runtime`

---

### Task 2: 실험 도구, MCP 연결과 지침 주입 실험

실험 목적은 설계 문서 6장, 7.4, 7.9의 ⚠️ 를 실측으로 바꾸는 것이다. 실험 코드는 버리는 코드라 테스트를 붙이지 않는다.

**Files:**
- Create: `spikes/lib/harness.mjs`, `spikes/lib/echo-mcp.mjs`, `spikes/01-mcp-connect.mjs`, `spikes/02-instructions.mjs`, `docs/superpowers/findings/2026-11-11-agent-wiring.md`

**Interfaces:**
- Produces (실험 전용):
  - `startEchoMcp(): Promise<{ url, token, calls: {tool, args, auth}[], close() }>` — 127.0.0.1 임의 포트의 Streamable HTTP MCP 서버. 도구 `dure_ping({ note: string })` 하나. `Authorization: Bearer <token>` 이 아니면 401.
  - `makeTempRepo(): Promise<string>` — 임시 폴더에 `git init` 과 빈 커밋 하나.
  - `runAgent({ command, args, env, cwd }): { write(s), waitFor(regexOrFn, ms), output(), kill() }` — node-pty로 띄우고 원본 출력을 `spikes/out/<이름>.log` 에 남긴다.
  - 결과 문서의 표 형식: `| 번호 | 질문 | Claude Code | Codex | 근거(로그 파일, 명령) |`. 값은 ✅ 실측 또는 ❌ 안 됨과 정확한 인자·키 이름.

- [ ] **Step 1: `harness.mjs`, `echo-mcp.mjs` 작성.**
- [ ] **Step 2: 실험 01, MCP 연결.** 각 에이전트를 임시 저장소에서 띄우고 "dure_ping 도구를 note='hello' 로 호출해" 를 입력한다. 통과 기준: `calls` 에 `{tool:'dure_ping', args:{note:'hello'}}` 가 올바른 토큰으로 기록된다. 시도할 주입 방식:
  - Claude Code: `--mcp-config <임시 폴더의 json>` 에 `{"mcpServers":{"dure":{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}}}`. `--strict-mcp-config` 유무에 따른 차이(사용자의 기존 MCP 서버가 같이 뜨는지)도 기록한다.
  - Codex: `-c mcp_servers.dure.url="…"` 와 `-c mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"`. 키 이름이 틀리면 `codex mcp add --help` 와 `codex mcp add` 가 `CODEX_HOME=<임시 폴더>` 에 쓰는 내용을 보고 맞는 키를 찾는다.
  - 두 경우 모두 실험 뒤 `git -C <임시 저장소> status --porcelain` 이 비어 있는지(저장소에 파일을 남기지 않았는지) 기록한다.
- [ ] **Step 3: 실험 02, 지침 주입.** 지침 "질문에 답할 때 첫 줄에 DURE-OK 라고 써라" 를 실행 인자로 넣고 "안녕" 을 입력한다. 통과 기준: 출력에 `DURE-OK`. Claude Code는 `--append-system-prompt`. Codex는 `-c` 로 넣을 수 있는 지침 키를 `codex --help`, `codex debug` 하위 명령, 공식 문서에서 찾아 시도한다. 인자로 안 되면 설계 문서 6장의 물러서는 순서 (1)(두레 폴더의 설정 파일, 예: `-p` 프로필이나 `CODEX_HOME`)을 시도하고 기존 로그인에 주는 영향을 기록한다.
- [ ] **Step 4: 결과 문서에 1, 2번 행 기록.**
- [ ] **Step 5: 커밋.** `chore: spike agent mcp wiring and instruction injection`

---

### Task 3: 전달과 중단 실험

**Files:**
- Create: `spikes/03-wake-idle.mjs`, `spikes/04-inject-busy.mjs`, `spikes/05-interrupt.mjs`
- Modify: `docs/superpowers/findings/2026-11-11-agent-wiring.md`

**Interfaces:**
- Consumes: Task 2의 `startEchoMcp`, `makeTempRepo`, `runAgent`.

- [ ] **Step 1: 실험 03, 쉬는 중 깨우기.** 에이전트가 첫 응답을 끝내고 입력 대기 중일 때 터미널에 "dure_ping 을 note='wake' 로 호출해" 와 Enter를 써 넣는다. 통과 기준: `calls` 에 `note:'wake'`. 줄바꿈이 든 긴 글도 한 번에 들어가는지(bracketed paste 필요 여부), Enter로 보낼 바이트(`\r`)를 기록한다. Codex는 `codex queue --thread <세션> --message …` 로도 시도하고, 세션 식별자를 실행 시점에 어떻게 아는지 기록한다.
- [ ] **Step 2: 실험 04, 작업 중 끼워 넣기.** "sleep 20 을 실행한 뒤 dure_ping 을 note='first' 로 호출해" 를 시키고, 실행 도중 "note 를 'second' 로 바꿔라" 를 끼워 넣는다. 통과 기준: `calls` 에 `note:'second'`.
  - Claude Code: `--settings <임시 json>` 으로 hook을 건다. `PostToolUse` hook이 `additionalContext` 를 돌려주는 방식과 `Stop` hook이 `decision:"block"` 과 이유를 돌려주는 방식을 각각 시험한다.
  - Codex: `hooks` 기능(이 PC의 `codex features list` 에 stable로 나온다)의 설정 위치와 형식을 찾아 같은 시험을 한다. hook을 인자나 두레 폴더 설정으로 걸 수 있는지, 신뢰 확인(`--dangerously-bypass-hook-trust`)이 필요한지 기록한다.
  - 둘 다 안 되면 "현재 응답이 끝난 직후 전달"(실험 03 방식)이 동작하는지만 확인해 기록한다.
- [ ] **Step 3: 실험 05, 중단.** `sleep 60` 실행 중에 `\x1b`(Esc) 와 `\x03`(Ctrl-C)를 각각 보낸다. 통과 기준: 에이전트 프로세스는 살아 있고 실행 중이던 명령만 멈춰 입력 대기로 돌아온다. 에이전트별로 맞는 바이트를 기록한다.
- [ ] **Step 4: 결과 문서에 3, 4, 5번 행 기록, 커밋.** `chore: spike agent wake, mid-turn injection and interrupt`

---

### Task 4: 권한 모드와 상태 감지 실험, 결과 정리

**Files:**
- Create: `spikes/06-permission-modes.mjs`, `spikes/07-state-detect.mjs`, `spikes/08-codex-sandbox.mjs`, `spikes/09-path-prefix.mjs`
- Modify: `docs/superpowers/findings/2026-11-11-agent-wiring.md`, `docs/superpowers/specs/2026-11-11-dure-v1-design.md` (7.4, 7.9, 12장)

- [ ] **Step 1: 실험 06, 권한 모드 대응.** `ask` 후보로 Claude Code `--permission-mode acceptEdits`, Codex `--sandbox workspace-write --ask-for-approval on-request` 를 시험한다. 파일 수정은 묻지 않고, 저장소 밖에 영향을 주는 명령(`curl https://example.com`)은 승인 창이 뜨는지 기록한다. `bypass` 후보로 Claude Code `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox` 가 묻지 않고 실행하는지 기록한다.
- [ ] **Step 2: 실험 07, 상태 감지.** 세 상태(작업 중, 쉬는 중, 승인 창에서 사용자 기다림)를 터미널 출력 해석 없이 알아낼 신호를 찾는다. Claude Code는 hook(`UserPromptSubmit`, `Stop`, `Notification`, 권한 요청 관련 hook), Codex는 hook과 `notify` 설정을 시험한다. 각 신호가 echo 서버나 파일에 찍히는 시점을 기록한다. 신호가 없는 상태는 "출력 패턴으로 추정" 이라고 적고 패턴을 남긴다.
- [ ] **Step 3: 실험 08, Codex 샌드박스.** `workspace-write` 에서 `python3 -m http.server 8765` 를 백그라운드로 띄우고 `curl localhost:8765` 를 실행하게 한다. 승인 없이 되는지, 승인하면 되는지, 아예 막히는지 기록한다(장면 1의 전제).
- [ ] **Step 4: 실험 09, PATH 앞에 끼우기.** `env.PATH` 앞에 임시 폴더를 넣고 그 안에 "DURE-GIT-SHIM" 을 출력하는 `git` 스크립트를 둔다. 에이전트에게 `git status` 를 시킨다. 통과 기준: 출력에 `DURE-GIT-SHIM`. 에이전트가 사용자 셸 설정을 다시 읽어 `PATH` 를 덮어쓰는지가 관건이다(3단계 `git` 대리 실행 파일의 전제).
- [ ] **Step 5: 결과 문서 완성.** 6~9번 행을 채우고, 문서 끝에 "확정된 실행 방식" 절을 쓴다. 에이전트별로 실행 파일, 인자, 환경변수, 두레 폴더에 쓰는 파일을 Task 9가 그대로 옮겨 쓸 수 있게 적는다.
- [ ] **Step 6: 설계 문서 갱신.** 7.4, 7.9의 ⚠️ 를 실측 결과로 바꾸고 12장에서 해소된 항목을 지운다.
- [ ] **Step 7: 사용자 보고 후 대기.** 결과 요약을 사용자에게 보고한다. 설계 문서의 전제(인자·환경변수 주입, 쉬는 중 깨우기, `PATH` 끼우기, Codex 샌드박스에서 서버 실행) 중 하나라도 ❌ 면 Task 5로 넘어가지 말고 사용자 결정을 기다린다.
- [ ] **Step 8: 커밋.** `docs: record agent wiring findings and settle spec open items`

---

### Task 5: 타입, DB, 저장소(store)

**Files:**
- Create: `src/shared/types.ts`, `src/core/db.ts`, `src/core/stores.ts`
- Test: `tests/core/stores.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export type AgentKind = 'claude' | 'codex';
export type PermissionMode = 'ask' | 'bypass';
export type WorkspaceStatus = 'stopped' | 'idle' | 'working' | 'waiting_user';
export interface Project { id: string; name: string; createdAt: number }
export interface Repo { id: string; projectId: string; name: string; path: string }
export interface Workspace {
  id: string; projectId: string; repoId: string;
  name: string; nameLocked: boolean; summary: string;
  branch: string; baseBranch: string; worktreePath: string;
  agentKind: AgentKind; permissionMode: PermissionMode;
  status: WorkspaceStatus; createdAt: number;
}
export interface TerminalInfo { id: string; workspaceId: string; kind: 'agent' | 'shell'; title: string }

// src/core/db.ts
export function openDatabase(file: string): Database.Database; // ':memory:' 허용, PRAGMA user_version 으로 마이그레이션, foreign_keys ON

// src/core/stores.ts
export class ProjectStore { constructor(db); create(name: string): Project; list(): Project[]; get(id: string): Project | undefined; remove(id: string): void }
export class RepoStore { constructor(db); add(projectId: string, path: string): Repo; list(projectId: string): Repo[]; get(id: string): Repo | undefined; remove(id: string): void }
export type NewWorkspace = Omit<Workspace, 'summary' | 'status' | 'createdAt'> & { token: string };
export class WorkspaceStore {
  constructor(db);
  insert(w: NewWorkspace): Workspace;            // summary '', status 'stopped'
  list(projectId: string): Workspace[]; get(id: string): Workspace | undefined;
  findByToken(token: string): Workspace | undefined; getToken(id: string): string;
  update(id: string, patch: Partial<Pick<Workspace, 'name' | 'nameLocked' | 'summary' | 'status'>>): Workspace;
  remove(id: string): void;
}
```

- `Repo.name` 은 경로의 마지막 폴더 이름이다. id는 `crypto.randomUUID()`. 토큰은 `Workspace` 타입에 넣지 않는다(화면으로 나가면 안 된다).
- 프로젝트를 지우면 그 저장소와 워크스페이스 행도 지워진다(`ON DELETE CASCADE`). 워크스페이스가 쓰는 저장소는 지울 수 없다(`RESTRICT`).

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('프로젝트 생성과 목록', () => { /* create('쇼핑몰') → list() 길이 1, name '쇼핑몰' */ });
test('같은 프로젝트에 같은 경로의 저장소를 두 번 등록하면 오류', () => { /* add 두 번 → toThrow */ });
test('Repo.name 은 경로 마지막 폴더', () => { /* add(p, '/tmp/a b/프론트') → name '프론트' */ });
test('워크스페이스 insert 기본값', () => { /* summary '' , status 'stopped' */ });
test('토큰으로 찾기, 없는 토큰은 undefined', () => {});
test('get/list 결과에 token 필드가 없다', () => { /* expect('token' in ws).toBe(false) */ });
test('update 는 지정한 필드만 바꾼다', () => { /* update(id,{summary:'로그인 API'}) → name 그대로 */ });
test('프로젝트 삭제 시 저장소·워크스페이스도 삭제', () => {});
test('워크스페이스가 쓰는 저장소 삭제는 오류', () => {});
test('파일 DB를 닫았다 다시 열어도 데이터가 남는다', () => { /* 임시 파일 경로 사용 */ });
```

- [ ] **Step 2: `pnpm test tests/core/stores.test.ts`** 기대: FAIL (모듈 없음).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 테스트 통과 확인, 커밋.** `feat(core): add sqlite schema and stores`

---

### Task 6: slug와 git 감싸기

**Files:**
- Create: `src/core/slug.ts`, `src/core/git.ts`
- Test: `tests/core/slug.test.ts`, `tests/core/git.test.ts`

**Interfaces:**
- Produces:

```ts
// src/core/slug.ts
export function slugify(name: string): string;
// 앞뒤 공백 제거 → 공백 연속을 '-' 하나로 → git ref에 못 쓰는 문자(~ ^ : ? * [ \ 제어문자)와 '/' 제거
// → '..' 를 '.' 로 → 앞의 '-' '.' 와 뒤의 '.' 제거. 한글은 그대로 둔다. 결과가 비면 'ws'.
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string; // base, base-2, base-3 …

// src/core/git.ts
export class GitError extends Error { stderr: string }
export function isGitRepo(path: string): Promise<boolean>;
export function listBranches(repoPath: string): Promise<string[]>;      // 로컬 브랜치 짧은 이름
export function currentBranch(repoPath: string): Promise<string>;
export function branchExists(repoPath: string, branch: string): Promise<boolean>;
export function addWorktree(o: { repoPath: string; worktreePath: string; branch: string; baseBranch: string }): Promise<void>; // git -C repo worktree add -b branch worktreePath baseBranch
export function removeWorktree(o: { repoPath: string; worktreePath: string }): Promise<void>; // worktree remove --force, 그 뒤 worktree prune
```

- [ ] **Step 1: 실패하는 테스트 작성.** git 테스트는 `os.tmpdir()` 아래 `두레 테스트 repo` 라는 이름의 폴더에 실제 저장소를 만들어 쓴다(공백과 한글, Review Focus 1).

```ts
test.each([
  ['로그인 기능', '로그인-기능'], ['  a   b ', 'a-b'], ['feat/x:y', 'featxy'],
  ['..hidden..', 'hidden'], ['???', 'ws'],
])('slugify(%s) = %s', (i, o) => expect(slugify(i)).toBe(o));
test('uniqueSlug 는 겹치면 -2, -3 을 붙인다', () => {
  const taken = new Set(['a', 'a-2']);
  expect(uniqueSlug('a', c => taken.has(c))).toBe('a-3');
});

test('isGitRepo: 저장소는 true, 일반 폴더와 없는 경로는 false', async () => {});
test('addWorktree 는 공백·한글 경로에 새 브랜치로 worktree 를 만든다', async () => {
  // worktreePath = <tmp>/두레 wt/프론트 화면 → 폴더 존재, 그 안의 currentBranch 가 'dure/프론트-화면'
});
test('없는 기준 브랜치면 GitError 이고 stderr 가 채워진다', async () => {});
test('removeWorktree 뒤 폴더가 없고 git worktree list 에서 빠진다', async () => {});
test('listBranches 는 로컬 브랜치 이름을 돌려준다', async () => {});
```

- [ ] **Step 2: 실패 확인 → 구현(`execFile('git', [...])`) → 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add slug rules and git worktree wrapper`

---

### Task 7: 셸 환경과 PtyManager

**Files:**
- Create: `src/core/shellEnv.ts`, `src/core/pty.ts`
- Test: `tests/core/pty.test.ts`, `tests/core/shellEnv.test.ts`

**Interfaces:**
- Produces:

```ts
// src/core/shellEnv.ts
export function resolveShellEnv(shell?: string, timeoutMs?: number): Promise<Record<string, string>>;
// `$SHELL -ilc 'env -0'` 를 실행해 로그인 셸 환경을 읽는다. 기본 5000ms. 실패하거나 시간 초과면 process.env 를 돌려준다.

// src/core/pty.ts
export interface SpawnOptions {
  workspaceId: string; kind: 'agent' | 'shell'; title: string;
  command: string; args: string[]; cwd: string; env: Record<string, string>;
  cols: number; rows: number;
}
export class PtyManager extends EventEmitter {
  spawn(o: SpawnOptions): TerminalInfo;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  killAll(): void;
  list(workspaceId: string): TerminalInfo[];
  buffer(id: string): string;        // 최근 출력, 최대 200_000자 (화면 다시 붙일 때 재생용)
  pid(id: string): number;
  // 이벤트: 'data' (id, chunk: string), 'exit' (id, exitCode: number)
}
```

- `exit` 뒤에는 그 터미널이 `list` 에서 빠진다. 없는 id에 대한 `write`/`resize`/`kill` 은 조용히 무시한다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('spawn 한 프로세스의 출력이 data 이벤트로 온다', async () => { /* /bin/sh -c 'echo dure-hi' → 'dure-hi' 포함 */ });
test('write 한 입력이 프로세스에 전달된다', async () => { /* /bin/cat 에 'abc\n' → 출력에 'abc' */ });
test('공백·한글이 든 cwd 에서 실행된다', async () => { /* pwd 출력이 그 경로로 끝남 */ });
test('exit 이벤트 뒤 list 에서 빠진다', async () => {});
test('buffer 는 최근 200_000자만 보관한다', async () => { /* 250_000자 출력 → buffer 길이 200_000 */ });
test('killAll 뒤 자식 프로세스가 남지 않는다', async () => {
  // sleep 1000 두 개 spawn → pid 기록 → killAll → 각 pid 에 process.kill(pid, 0) 이 ESRCH 를 던질 때까지 2초 안에 확인
});
test('resolveShellEnv 는 PATH 를 포함한다', async () => {});
test('resolveShellEnv 는 셸이 없으면 process.env 를 돌려준다', async () => { /* shell='/nonexistent' */ });
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add pty manager and login shell env resolution`

---

### Task 8: MCP 서버 뼈대

**Files:**
- Create: `src/core/mcp/server.ts`, `src/core/mcp/tools/workspace.ts`
- Test: `tests/core/mcp.test.ts`

**Interfaces:**
- Consumes: `WorkspaceStore.findByToken`, `ProjectStore.get`.
- Produces:

```ts
// src/core/mcp/server.ts
export interface McpContext { workspace: Workspace; project: Project }
export interface McpDeps { workspaces: WorkspaceStore; projects: ProjectStore }
export type ToolBundle = (server: McpServer, ctx: McpContext, deps: McpDeps) => void;
export function startMcpServer(deps: McpDeps, bundles: ToolBundle[], port?: number):
  Promise<{ port: number; url: string; close(): Promise<void> }>;   // url = http://127.0.0.1:<port>/mcp

// src/core/mcp/tools/workspace.ts
export const workspaceTools: ToolBundle;   // 도구 workspace_whoami 등록
```

- `127.0.0.1` 에만 묶는다. `port` 를 안 주면 임의 포트.
- 요청마다 `Authorization: Bearer <token>` 으로 워크스페이스를 찾는다. 없거나 틀리면 HTTP 401. `/mcp` 가 아닌 경로는 404.
- 요청마다 그 워크스페이스의 `McpContext` 로 서버 인스턴스를 만들어 처리한다(상태 없는 Streamable HTTP). 뒤 단계는 `ToolBundle` 파일을 더하는 것으로 도구를 늘린다.
- `workspace_whoami` 는 인자가 없고, 텍스트 내용으로 JSON `{ workspaceId, workspaceName, projectId, projectName, agentKind }` 을 돌려준다.

- [ ] **Step 1: 실패하는 테스트 작성.** SDK의 `Client` 와 `StreamableHTTPClientTransport` 로 실제 접속한다.

```ts
test('올바른 토큰이면 도구 목록에 workspace_whoami 가 있다', async () => {});
test('workspace_whoami 는 토큰의 워크스페이스와 프로젝트를 돌려준다', async () => {
  // JSON.parse(text) 가 { workspaceId: ws.id, workspaceName: ws.name, projectId: p.id, projectName: p.name, agentKind: 'claude' }
});
test('서로 다른 토큰은 서로 다른 워크스페이스로 답한다', async () => {});
test('토큰이 없거나 틀리면 401', async () => { /* fetch POST → status 401 */ });
test('/mcp 가 아닌 경로는 404', async () => {});
test('서버는 127.0.0.1 에만 묶인다', async () => { /* server.address().address === '127.0.0.1' */ });
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add token-authenticated mcp server skeleton`

---

### Task 9: 에이전트 실행과 WorkspaceService

**Files:**
- Create: `src/core/agents/instructions.ts`, `src/core/agents/launch.ts`, `src/core/workspaceService.ts`, `src/core/index.ts`
- Test: `tests/core/launch.test.ts`, `tests/core/workspaceService.test.ts`

**Interfaces:**
- Consumes: Task 4 결과 문서의 "확정된 실행 방식" 절, Task 5~8의 모든 Produces.
- Produces:

```ts
// src/core/agents/instructions.ts
export function baseInstructions(ws: Workspace, project: Project): string;

// src/core/agents/launch.ts
export interface AgentLaunch { command: string; args: string[]; env: Record<string, string>; files: { path: string; content: string }[] }
export function buildAgentLaunch(i: {
  kind: AgentKind; permissionMode: PermissionMode;
  mcpUrl: string; token: string; configDir: string; instructions: string;
}): AgentLaunch;

// src/core/workspaceService.ts
export class AgentNotInstalledError extends Error { kind: AgentKind }
export class WorktreeMissingError extends Error { worktreePath: string }
export interface CreateWorkspaceInput {
  projectId: string; repoId: string; name?: string; baseBranch: string;
  agentKind: AgentKind; permissionMode?: PermissionMode;   // 기본 'ask'
}
export class WorkspaceService extends EventEmitter {
  create(i: CreateWorkspaceInput): Promise<Workspace>;
  remove(id: string, o: { deleteWorktree: boolean }): Promise<void>;
  startAgent(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo>;
  openShell(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo>;
  // 이벤트: 'changed' (workspaceId)
}

// src/core/index.ts
export interface Core {
  projects: ProjectStore; repos: RepoStore; workspaces: WorkspaceStore;
  service: WorkspaceService; pty: PtyManager; mcpUrl: string;
  addRepo(projectId: string, path: string): Promise<Repo>;   // isGitRepo 가 false 면 오류
  dispose(): Promise<void>;                                   // pty.killAll, mcp close, db close
}
export function createCore(o: { dataDir: string; worktreeRoot: string; baseEnv: Record<string, string> }): Promise<Core>;
```

`CreateWorkspaceInput` 은 화면도 쓰므로 `src/shared/types.ts` 에 정의하고 `workspaceService.ts` 가 다시 내보낸다.

동작 규칙:

- `baseInstructions` 는 다음을 담는다: 두레 안에서 돌고 있다는 것, 워크스페이스·프로젝트 이름, `dure` MCP 도구를 쓸 수 있다는 것, 그리고 문장 "커밋 메시지는 작성만 하고 `git commit`, `git push`, 배포는 실행하지 마라. 사용자가 직접 한다."
- `buildAgentLaunch` 의 인자·환경변수·파일은 Task 4 결과 문서의 값을 그대로 옮긴다. 결과 문서와 아래 예상값이 다르면 결과 문서가 이긴다. 예상값: Claude Code는 `configDir/mcp.json` 을 `files` 에 넣고 `--mcp-config`, `--append-system-prompt`, `ask` 면 `--permission-mode acceptEdits`, `bypass` 면 `--dangerously-skip-permissions`. Codex는 `-c mcp_servers.dure.url=…`, `-c mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"`, `env.DURE_MCP_TOKEN`, `ask` 면 `--sandbox workspace-write --ask-for-approval on-request`, `bypass` 면 `--dangerously-bypass-approvals-and-sandbox`.
- `files` 의 경로는 전부 `configDir` 아래여야 한다. `configDir` 는 `<dataDir>/workspaces/<워크스페이스 id>` 다.
- `create`: 이름을 주면 `nameLocked: true`, 안 주면 `<저장소 이름>-<그 프로젝트의 워크스페이스 수+1>` 이고 `nameLocked: false`. slug는 브랜치 `dure/<slug>` 와 worktree 폴더가 모두 비어 있는 것으로 `uniqueSlug` 가 고른다. 토큰은 `crypto.randomBytes(32).toString('hex')`. 순서는 worktree 생성 → 행 insert. worktree 생성이 실패하면 행을 남기지 않고, insert가 실패하면 만든 worktree를 지운다.
- `startAgent`: 그 워크스페이스에 에이전트 터미널이 이미 있으면 그것을 돌려준다. `worktreePath` 가 없으면 `WorktreeMissingError`. `baseEnv.PATH` 에서 실행 파일(`claude` 또는 `codex`)을 못 찾으면 `AgentNotInstalledError`. `files` 를 쓰고, `env` 는 `baseEnv` 위에 `launch.env` 를 덮어 PTY를 띄운다. 시작하면 상태를 `idle`, 에이전트 터미널이 끝나면 `stopped` 로 바꾸고 `changed` 를 낸다. (`working`, `waiting_user` 감지는 Task 4 결과에 따라 뒤 단계에서 붙인다.)
- `openShell`: `baseEnv.SHELL`(없으면 `/bin/zsh`)을 `-l` 로 worktree에서 띄운다.
- `remove`: 그 워크스페이스의 터미널을 전부 끄고, `deleteWorktree` 면 `removeWorktree`, 그 뒤 행과 `configDir` 를 지운다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
// launch.test.ts — 기대값은 Task 4 결과 문서의 값으로 채운다
test('claude ask: mcp 설정 파일이 configDir 아래에 있고 URL 과 Bearer 토큰을 담는다', () => {});
test('claude bypass 와 ask 는 권한 인자만 다르다', () => {});
test('codex: 토큰은 인자가 아니라 env 로만 넘어간다', () => { /* args.join(' ') 에 token 문자열 없음 */ });
test('모든 files 경로는 configDir 아래다', () => {});
test('지침 문구에 커밋·push·배포 금지 문장이 있다', () => {});

// workspaceService.test.ts — 임시 dataDir, 임시 worktreeRoot, 실제 임시 저장소
test('create 는 worktree 와 브랜치 dure/<slug> 를 만들고 status 는 stopped', async () => {});
test('이름을 주면 nameLocked true, 안 주면 false 이고 "<저장소>-1"', async () => {});
test('같은 이름으로 두 번 만들면 두 번째 브랜치는 -2 가 붙는다', async () => {});
test('없는 기준 브랜치면 실패하고 워크스페이스 목록이 비어 있다', async () => {});          // Review Focus 3
test('create 뒤 저장소 작업 트리에 변경이 없다', async () => { /* git status --porcelain 이 '' */ });
test('worktree 폴더가 지워졌으면 startAgent 는 WorktreeMissingError', async () => {});      // Review Focus 4
test('PATH 에 에이전트가 없으면 AgentNotInstalledError 이고 kind 가 맞다', async () => {    // Review Focus 2
  // baseEnv.PATH = '/usr/bin:/bin'
});
test('startAgent 는 두 번 불러도 같은 터미널을 돌려준다', async () => {
  // baseEnv.PATH 앞에 임시 폴더를 넣고 그 안에 `claude` 라는 이름의 실행 가능한 `sleep 1000` 스크립트를 둔다
});
test('startAgent 뒤 status idle, 에이전트 종료 뒤 stopped 이고 changed 가 난다', async () => {});
test('가짜 에이전트는 worktree 를 cwd 로, DURE 설정 파일이 쓰인 상태로 뜬다', async () => {
  // 가짜 `claude` 가 pwd 와 "$@" 를 출력 → 출력에 worktreePath 와 configDir 경로
});
test('remove(deleteWorktree:true) 뒤 폴더·행·configDir 가 없다', async () => {});
test('createCore: addRepo 는 git 저장소가 아니면 오류', async () => {});
test('createCore: dispose 뒤 MCP 포트가 닫힌다', async () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add agent launch and workspace service`

---

### Task 10: 메인 프로세스와 IPC

**Files:**
- Create: `src/shared/ipc.ts`, `src/main/ipc.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`
- Test: `tests/core/ipcContract.test.ts`

**Interfaces:**
- Consumes: `createCore`, `Core`, `resolveShellEnv`.
- Produces:

```ts
// src/shared/ipc.ts
export type ChangeTopic = 'projects' | 'repos' | 'workspaces' | 'terminals';
export interface DureApi {
  projects: { list(): Promise<Project[]>; create(name: string): Promise<Project>; remove(id: string): Promise<void> };
  repos: {
    list(projectId: string): Promise<Repo[]>; pickFolder(): Promise<string | null>;
    add(projectId: string, path: string): Promise<Repo>; branches(repoId: string): Promise<string[]>;
    remove(id: string): Promise<void>;
  };
  workspaces: {
    list(projectId: string): Promise<Workspace[]>; create(i: CreateWorkspaceInput): Promise<Workspace>;
    remove(id: string, o: { deleteWorktree: boolean }): Promise<void>;
  };
  terminals: {
    list(workspaceId: string): Promise<TerminalInfo[]>;
    startAgent(workspaceId: string, size: { cols: number; rows: number }): Promise<TerminalInfo>;
    openShell(workspaceId: string, size: { cols: number; rows: number }): Promise<TerminalInfo>;
    write(id: string, data: string): void; resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>; buffer(id: string): Promise<string>;
    onData(cb: (id: string, chunk: string) => void): () => void;
    onExit(cb: (id: string, exitCode: number) => void): () => void;
  };
  onChanged(cb: (topic: ChangeTopic) => void): () => void;
}
export const IPC_CHANNELS: readonly string[];   // 'projects.list' 같은 '<묶음>.<메서드>' 이름 전부
```

- `window.dure: DureApi`. 채널 이름은 `IPC_CHANNELS` 한 곳에서만 정의하고 메인과 preload가 같이 쓴다.
- 코어에서 던진 오류는 화면에서 `Error` 로 받되 `message` 가 보존된다. `AgentNotInstalledError`, `WorktreeMissingError` 는 `message` 앞에 각각 `AGENT_NOT_INSTALLED:<kind>:`, `WORKTREE_MISSING:` 을 붙여 화면이 가려낼 수 있게 한다.
- 메인은 시작할 때 `resolveShellEnv()` 로 `baseEnv` 를 얻어 `createCore` 에 넘긴다. `dataDir` 은 `app.getPath('userData')`(앱 이름 `dure`), `worktreeRoot` 는 `~/dure/worktrees`.
- 종료: `before-quit` 에서 `core.dispose()` 가 끝난 뒤 종료한다(Review Focus 5). 창을 모두 닫으면 앱도 끝낸다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('IPC_CHANNELS 는 DureApi 의 모든 메서드를 한 번씩 담는다', () => {
  // 기대 목록을 손으로 적어 정렬 비교: projects.list, projects.create, projects.remove, repos.list, repos.pickFolder,
  // repos.add, repos.branches, repos.remove, workspaces.list, workspaces.create, workspaces.remove, terminals.list,
  // terminals.startAgent, terminals.openShell, terminals.write, terminals.resize, terminals.kill, terminals.buffer
});
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인, `pnpm typecheck` 통과.**
- [ ] **Step 3: 손으로 확인.** `pnpm dev` 로 띄우고 개발자 도구 콘솔에서 `await window.dure.projects.create('시험')` 뒤 `await window.dure.projects.list()` 가 그 프로젝트를 돌려준다. 앱을 껐다 켜도 남아 있다.
- [ ] **Step 4: 커밋.** `feat(main): expose core over typed ipc`

---

### Task 11: 화면, 목록과 만들기

**Files:**
- Create: `src/renderer/tree.ts`, `src/renderer/styles.css`, `src/renderer/components/Sidebar.tsx`, `src/renderer/components/ProjectView.tsx`, `src/renderer/components/dialogs.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/tree.test.ts`

**Interfaces:**
- Consumes: `window.dure` (`DureApi`).
- Produces:

```ts
// src/renderer/tree.ts
export type Selection = { type: 'project'; id: string } | { type: 'workspace'; id: string } | null;
export interface TreeNode { project: Project; workspaces: Workspace[] }
export function buildTree(projects: Project[], workspaces: Workspace[]): TreeNode[];   // 프로젝트·워크스페이스 모두 createdAt 오름차순
export function reconcileSelection(sel: Selection, tree: TreeNode[]): Selection;       // 선택 대상이 사라졌으면 그 프로젝트, 그것도 없으면 null
```

화면 규칙:

- 왼쪽 목록은 프로젝트 아래 워크스페이스가 달린 2단이다. 어느 단을 눌렀는지가 `Selection` 이 된다(설계 7.1).
- 워크스페이스 줄에는 이름, 한 줄 요약(비어 있으면 줄을 비운다), 상태 점이 보인다. 상태 글자: `stopped` "꺼짐", `idle` "쉬는 중", `working` "작업 중", `waiting_user` "사용자 기다림".
- 프로젝트를 선택하면 오른쪽에 `ProjectView`: 등록된 저장소 목록과 "저장소 추가"(폴더 고르기), 워크스페이스 목록과 "워크스페이스 만들기". 조율 에이전트 자리는 4단계에서 채운다.
- 워크스페이스 만들기 창의 입력: 저장소(프로젝트에 등록된 것 중), 기준 브랜치(`repos.branches`), 에이전트(Claude Code / Codex), 이름(선택), 권한 모드(기본 "승인 필요"). "승인 생략" 을 고르면 문구 "에이전트가 묻지 않고 모든 명령을 실행합니다. 믿는 저장소에서만 켜세요." 를 보여준다.
- 지우기는 확인 창을 거친다. 워크스페이스 지우기 확인 창에는 "작업 폴더(worktree)도 삭제" 체크가 있고 기본은 꺼짐이다.
- 실패는 창 안에 오류 `message` 를 그대로 보여준다.
- `onChanged` 를 받으면 해당 목록을 다시 읽는다. 상태 관리 라이브러리는 쓰지 않는다.
- 화면 글자는 한국어다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('buildTree 는 워크스페이스를 프로젝트 아래에 createdAt 순으로 묶는다', () => {});
test('워크스페이스가 없는 프로젝트도 노드로 나온다', () => {});
test('reconcileSelection: 선택한 워크스페이스가 사라지면 그 프로젝트를 선택한다', () => {});
test('reconcileSelection: 프로젝트도 사라지면 null', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인.**
- [ ] **Step 3: 손으로 확인.** 프로젝트를 만들고, 이 저장소(`개인 챌린지`)를 저장소로 등록하고, 워크스페이스를 만든다. `~/dure/worktrees/` 아래 폴더가 생기고 목록에 "꺼짐" 으로 뜬다. git 저장소가 아닌 폴더를 등록하면 오류가 보인다.
- [ ] **Step 4: 커밋.** `feat(renderer): add project and workspace tree with creation dialogs`

---

### Task 12: 화면, 터미널과 에이전트 실행

**Files:**
- Create: `src/renderer/components/WorkspaceView.tsx`, `src/renderer/components/TerminalPane.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.dure.terminals`, Task 11의 `Selection`.

화면 규칙:

- 워크스페이스를 선택하면 `WorkspaceView`: 위에 터미널 탭, 아래에 선택된 터미널. 첫 탭은 에이전트 터미널이다. "+" 로 셸 터미널을 더 연다.
- 워크스페이스를 처음 선택했을 때 에이전트 터미널이 없으면 "에이전트 시작" 버튼을 보여준다. 자동으로 띄우지 않는다.
- `TerminalPane` 은 xterm.js 에 fit 애드온을 붙인다. 붙을 때 `terminals.buffer(id)` 를 먼저 써서 지난 출력을 되살리고, 그 뒤 `onData` 중 자기 id 것만 쓴다. 키 입력은 `terminals.write`, 크기 변화는 `terminals.resize` 로 보낸다. 떼어낼 때 구독을 해제한다.
- 다른 워크스페이스로 갔다 돌아와도 터미널 프로세스는 살아 있고 출력이 이어진다.
- 오류 `message` 가 `AGENT_NOT_INSTALLED:<kind>:` 로 시작하면 "Claude Code(또는 Codex)가 설치돼 있지 않거나 PATH 에 없습니다." 를, `WORKTREE_MISSING:` 으로 시작하면 "작업 폴더가 없습니다. 워크스페이스를 지우고 다시 만드세요." 를 보여준다.
- 터미널이 끝나면 탭에 "종료됨" 을 표시하고 에이전트 탭이면 "에이전트 시작" 을 다시 보여준다.

- [ ] **Step 1: 구현.**
- [ ] **Step 2: `pnpm typecheck`, `pnpm test` 통과 확인.**
- [ ] **Step 3: 손으로 전체 확인.** 결과를 항목별로 기록해 사용자에게 보고한다.
  1. Claude Code 워크스페이스에서 "에이전트 시작" → 터미널에 Claude Code가 뜨고 작업 폴더가 worktree다.
  2. 그 에이전트에게 "workspace_whoami 도구를 호출해 결과를 보여줘" → 워크스페이스 이름과 프로젝트 이름이 맞게 나온다.
  3. Codex 워크스페이스에서 1, 2를 반복한다.
  4. 두 워크스페이스의 `workspace_whoami` 결과가 서로 다르다.
  5. 셸 탭을 열어 `pwd` 가 worktree 경로다.
  6. 워크스페이스를 오갔다 돌아와도 터미널 내용이 남아 있다.
  7. 에이전트를 띄운 채 앱을 끄고 `ps -axo pid,command | grep -E "claude|codex"` 로 두레가 띄운 프로세스가 남지 않았는지 본다.
  8. 워크스페이스의 저장소에서 `git status --porcelain` 을 실행해 두레가 남긴 파일이 없는지 본다.
  9. `pnpm build` 가 성공한다.
- [ ] **Step 4: 커밋.** `feat(renderer): add terminal tabs and agent start`
