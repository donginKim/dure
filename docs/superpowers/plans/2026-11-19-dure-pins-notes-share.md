# 대화 핀, 메모 마크다운 보기, 조율 공개 범위 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대화의 글에 핀을 꽂아 바로 다시 보게 하고, 메모를 마크다운으로 보여 주고, 조율 에이전트의 공개 범위를 화면에서 정하게 한다.

**Architecture:** 핀은 코어의 `PinStore`(SQLite 표 `pins`)가 글의 id 와 내용 사본을 함께 담고, 화면(`ChatPane`)이 꽂기·목록·이동을 맡는다. 메모와 공개 범위는 화면만 바꾼다 (코어는 이미 된다).

**Tech Stack:** Electron, TypeScript, React, better-sqlite3, vitest (`npx -y pnpm@12.18.0 test`)

**Spec:** `docs/superpowers/specs/2026-11-19-dure-pins-notes-share-design.md`

## Global Constraints

- 화면의 글은 한국어. 기존 문체를 따른다 ("~합니다").
- 핀 본문 50,000자, 워크스페이스마다 핀 200개, 제목은 첫 줄 60자.
- 에이전트의 글은 HTML 로 넣지 않는다: 기존 `Markdown` 부품만 쓴다.
- 에이전트(MCP 도구)와 함께하는 사람에게는 핀을 내주지 않는다.
- DB 구조는 `src/core/db.ts` 의 `MIGRATIONS` 끝에 항목을 더해서만 바꾼다.

## Review Focus

- 지난 대화의 핀(글이 화면에 없음)을 눌렀을 때: 아무 일도 없으면 안 되고 담아 둔 내용이 펼쳐져야 한다. → Task 2 시험 `findEntry`
- 같은 글에 핀을 두 번: 둘이 되면 안 된다. → Task 1 시험
- 아주 긴 글에 핀: 잘라서 담고 오류를 내지 않는다. → Task 1 시험
- 워크스페이스를 지운 뒤: 그 핀이 남으면 안 된다. → Task 1 시험
- 조율 에이전트가 아직 없는 프로젝트의 함께 탭: 빈 줄이나 오류가 없어야 한다. → Task 4 직접 확인

---

### Task 1: 핀 저장소 (코어, IPC)

**Files:**
- Create: `src/core/pins.ts`, `tests/core/pins.test.ts`
- Modify: `src/core/db.ts` (MIGRATIONS 끝), `src/shared/types.ts`, `src/shared/ipc.ts`, `src/core/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
  ```ts
  export type PinKind = 'user' | 'assistant' | 'dure' | 'output' | 'peer';
  export interface Pin { id: string; workspaceId: string; itemId: string; kind: PinKind; source: string; title: string; body: string; createdAt: number }
  export interface PinInput { workspaceId: string; itemId: string; kind: PinKind; source: string; body: string }
  ```
- Produces (`src/core/pins.ts`): `MAX_PINS = 200`, `MAX_PIN_BODY = 50_000`, `class PinStore extends EventEmitter` with `list(workspaceId): Pin[]` (새 것부터), `add(input: PinInput): Pin` (같은 글이면 있던 것을 돌려준다), `remove(id): void`. 이벤트 `'changed'`.
- Produces (IPC): `window.dure.pins.list(workspaceId)`, `.add(input)`, `.remove(id)`; 바뀜 알림 주제 `'pins'`.

- [ ] **Step 1: 실패하는 시험** `tests/core/pins.test.ts` (`tests/core/notes.test.ts` 의 `beforeEach` 를 그대로 따른다)
  - `꽂고, 목록은 새 것부터, 뺀다`: 둘을 꽂으면 `list` 가 `[둘째, 첫째]`, `remove` 뒤 하나.
  - `같은 글은 한 번만`: 같은 `itemId` 로 두 번 `add` → `list` 길이 1, 두 번 모두 같은 `id`.
  - `제목은 첫 줄 60자, 본문은 50,000자에서 자른다`: `body = '\n\n' + 'ㄱ'.repeat(70) + '\n둘째'` → `title.length === 60`; `'a'.repeat(60_000)` → `body.length === 50_000`.
  - `200개를 넘으면 꽂지 못한다`: 201번째 `add` 가 `/200개/` 로 던진다.
  - `없는 워크스페이스, 빈 본문, 모르는 kind 는 던진다`.
  - `워크스페이스를 지우면 그 핀도 지워진다`: `core.service.remove(ws.id, { deleteWorktree: true })` 뒤 `list(ws.id)` 가 빈다.
- [ ] **Step 2:** `npx -y pnpm@12.18.0 test tests/core/pins.test.ts` → 실패 (모듈 없음)
- [ ] **Step 3: 구현.** 표:
  ```sql
  CREATE TABLE pins (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, item_id)
  );
  CREATE INDEX pins_workspace ON pins (workspace_id, created_at DESC);
  ```
  (워크스페이스 표가 지워질 때 따라 지워지지 않으면 `workspaceService.remove` 가 `todos.removeWorkspace` 를 부르는 자리에서 함께 지운다.) `source` 는 한 줄 80자로 다듬는다. `createCore` 에 `pins` 를 더하고 `Core` 에 내놓는다. IPC 세 개와 `'pins'` 알림은 `notes` 가 연결된 자리 다섯 곳을 그대로 따른다. MCP 도구는 만들지 않는다.
- [ ] **Step 4:** 같은 시험 → 통과. `npx -y pnpm@12.18.0 run typecheck` → 오류 없음.
- [ ] **Step 5:** `git commit -m "feat(pins): pin store for chat items"`

### Task 2: 핀 화면 (ChatPane)

**Files:**
- Create: `src/renderer/pinsView.ts`, `tests/renderer/pinsView.test.ts`, `src/renderer/components/PinList.tsx`
- Modify: `src/renderer/components/ChatPane.tsx`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: Task 1 의 `Pin`, `PinInput`, `window.dure.pins`, 그리고 `window.dure.notes.create({ title, body })`.
- Produces (`src/renderer/pinsView.ts`):
  ```ts
  export function pinInput(entry: Entry, workspaceId: string, workspaces: Workspace[]): PinInput | null  // 꽂을 수 없는 글이면 null
  export function pinSourceLabel(pin: Pin): string   // "에이전트", "나", "두레", 또는 담아 둔 source
  export function findEntry(entries: Entry[], pin: Pin): Entry | null   // 지금 화면에 그 글이 있는가
  ```

- [ ] **Step 1: 실패하는 시험** `tests/renderer/pinsView.test.ts`
  - `pinInput`: `user`/`assistant`/`dure`/`output` 은 본문이 그 글(`dure` 는 `title + '\n\n' + text`)이고 `kind` 가 같다. `peer` 는 `message.body`, `kind: 'peer'`, `source` 가 "…가 보냄"/"…에게 보냄". `steps` 와 `notice` 는 `null`. 본문이 공백뿐이면 `null`.
  - `findEntry`: 같은 `id` 가 있으면 그 항목, 없으면 `null` (지난 대화).
- [ ] **Step 2:** `npx -y pnpm@12.18.0 test tests/renderer/pinsView.test.ts` → 실패
- [ ] **Step 3: `pinsView.ts` 구현**, 시험 통과.
- [ ] **Step 4: `ChatPane` 과 `PinList`.**
  - `ChatPane` 이 `window.dure.pins.list(workspace.id)` 를 읽고 `onChanged` 의 `'pins'` 에서 다시 읽는다.
  - 항목마다 감싸는 요소에 `data-entry-id` 를 달고, 꽂을 수 있는 글은 마우스를 올리면 핀 단추(`title="핀 꽂기"` / `"핀 빼기"`, `aria-pressed`)가 보인다. 꽂힌 글은 단추가 늘 보인다.
  - 대화 위쪽에 `핀 N` 단추 (없으면 흐린 `핀`). 누르면 `PinList` 가 열린다. Esc 와 바깥 누르기로 닫힌다.
  - `PinList`: 줄마다 제목, `pinSourceLabel`, 시각, "메모로 보내기", "빼기". 줄을 누르면 `findEntry` 가 있으면 `onJump(entryId)`, 없으면 그 줄을 펼쳐 `<Markdown text={pin.body} />` 와 "지난 대화의 글입니다. 담아 둔 내용을 보여 줍니다." 를 보인다. 빈 목록: "글에 마우스를 올려 핀을 꽂으면 여기에 모입니다."
  - `onJump`: `stick.current = false` 로 두고 그 요소를 `scrollIntoView({ block: 'center' })`, 1.6초 동안 `pin-flash` 를 붙인다.
  - "메모로 보내기": `notes.create({ title: pin.title, body: pin.body })` 뒤 그 줄에 "메모에 담았습니다".
  - 오류(상한 등)는 목록 위에 한 줄로 보인다.
- [ ] **Step 5:** `npx -y pnpm@12.18.0 test` 와 `run typecheck` → 통과
- [ ] **Step 6:** `git commit -m "feat(pins): pin chat items and jump back to them"`

### Task 3: 메모 마크다운 보기

**Files:**
- Modify: `src/renderer/components/NotesPanel.tsx`, `src/renderer/styles.css`

- [ ] **Step 1:** 상태 `editing` 을 더한다. 메모를 열 때 본문이 비어 있으면 `true`, 아니면 `false`. `create()` 는 `true`.
- [ ] **Step 2:** `editing` 이 아니면 제목(글자)과 `<div className="notes-view"><Markdown text={note.body} /></div>` 를 그리고, 머리에 "고치기" 단추. `editing` 이면 지금의 입력칸과 "보기" 단추. "보기" 로 바꿀 때 `flush()` 를 기다린다.
- [ ] **Step 3:** `npx -y pnpm@12.18.0 test` 와 `run typecheck` → 통과
- [ ] **Step 4:** `git commit -m "feat(notes): render notes as markdown, edit on demand"`

### Task 4: 조율 에이전트의 공개 범위

**Files:**
- Modify: `src/renderer/components/SharePanel.tsx`, `src/core/peers/peerService.ts:1018-1026`
- Test: `tests/core/peers.test.ts`

- [ ] **Step 1: 실패하는 시험** `tests/core/peers.test.ts` 에 `조율 에이전트도 공개 범위를 정할 수 있고, 막혔을 때 어디서 푸는지 알려 준다`: 조율 워크스페이스에 `setSharing(id, 'all')` → `visibleTo(id, peerId)` 참. 공개하지 않은 조율이 다른 사람의 에이전트에게 보내면 오류 글에 `함께 탭` 이 들어 있다. (이 파일의 기존 두 인스턴스 준비 코드를 쓴다.)
- [ ] **Step 2:** 그 시험 → 실패 (오류 글에 `함께 탭` 없음)
- [ ] **Step 3:** `peerService.ts` 의 세 오류 글에서 "사용자에게 두레에서 이 워크스페이스를 공개해 달라고 하라" 를 "사용자에게 프로젝트의 함께 탭에서 이 워크스페이스를 공개해 달라고 하라" 로 바꾼다.
- [ ] **Step 4:** `SharePanel` 의 공개 범위 목록이 `everyone` 에서 `role === 'coordinator'` 인 것을 맨 앞에 더해 그린다. 그 줄의 이름은 "조율 에이전트", 아래에 "공개하면 그 사람의 에이전트와 메시지와 자료(기획서 등)를 주고받습니다. 일을 나눠 준 사람에게는 저절로 공개됩니다." 공개 범위를 읽는 `ids` 에도 넣는다. 조율 워크스페이스가 없으면 줄이 없다.
- [ ] **Step 5:** `npx -y pnpm@12.18.0 test` 와 `run typecheck` → 통과
- [ ] **Step 6:** `git commit -m "feat(share): let the coordinator's audience be set in the share tab"`

### Task 5: 실제 앱에서 확인

- [ ] `npx -y pnpm@12.18.0 exec electron-vite build` 뒤, 분리된 데이터 폴더(`DURE_DATA_DIR`, `DURE_WORKTREE_ROOT`, `DURE_REPO_ROOT`, `DURE_START_MINIMIZED=1`)와 `--remote-debugging-port` 로 띄운다.
- [ ] 핀: 글에 꽂기 → `핀 1` → 위로 스크롤 → 핀으로 이동해 강조되는지 → 화면에 없는 id 의 핀을 눌러 내용이 펼쳐지는지 → 메모로 보내기.
- [ ] 메모: 마크다운(제목, 목록, 표)이 그려지는지, 고치기와 보기가 오가는지.
- [ ] 함께 탭: 조율을 켠 프로젝트에서 "조율 에이전트" 줄이 보이고 선택이 저장되는지, 조율이 없는 프로젝트에서 줄이 없는지.
