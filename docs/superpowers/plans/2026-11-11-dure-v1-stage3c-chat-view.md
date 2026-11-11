# 두레 버전 1, 3C단계 (채팅 보기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워크스페이스의 에이전트 대화를 터미널 대신 채팅 형태로도 볼 수 있게 한다. 에이전트의 말은 글로, 한 일은 접힌 한 줄로, 내 말은 오른쪽 말풍선으로 보이고, 에이전트끼리 주고받은 메시지도 같은 흐름 안에 끼워 보인다. 터미널 보기와 언제든 오갈 수 있다.

**Architecture:** 에이전트는 지금처럼 터미널에서 돈다. 채팅 보기는 그 위에 얹는 다른 화면일 뿐이다. 재료는 Claude Code 가 스스로 쓰는 대화 기록 파일(JSONL)이다: hook 신호마다 그 파일의 경로가 오고, 코어가 파일의 새 줄을 읽어 화면이 쓸 "대화 항목" 으로 바꿔 내보낸다. 채팅의 입력창에 쓴 글은 에이전트의 터미널에 써 넣는다. 두 보기는 같은 에이전트를 보므로 전환해도 대화가 이어진다.

**Tech Stack:** 1~3B단계와 같음. 새 의존성 없음(마크다운은 필요한 만큼만 직접 그린다).

**Spec:** `docs/superpowers/specs/2026-11-11-dure-v1-design.md` (이 계획의 Task 6에서 7.10 절을 새로 쓴다). 실험 근거: `docs/superpowers/findings/2026-11-11-agent-wiring.md`.

## 사용자가 정한 것

- 워크스페이스 보기를 터미널과 채팅으로 전환할 수 있다. 처음 열면 터미널이다.
- 채팅은 가운데 한 줄로 흐르는 대화다. 에이전트의 말은 글로, 한 일은 "명령 N개 실행함" 같은 접힌 한 줄로, 내 말은 오른쪽 말풍선으로, 위에 작업 시간, 아래에 입력창. (사용자가 보여준 화면 기준)
- 접힌 줄을 펼치면 한 일이 한 줄씩 보이고, 그 줄을 펼치면 터미널에 나오던 내용이 그대로 보인다. (앞서 고른 "B+C")
- 에이전트끼리 주고받은 메시지도 별도 패널이 아니라 이 대화 흐름 안에 보인다.

## 이 계획이 정한 것

1. **재료는 Claude Code 의 대화 기록 파일이다.** 형식은 Claude Code 내부의 것이라 버전이 오르면 바뀔 수 있다. 읽지 못하는 줄은 건너뛰고, 아무것도 읽지 못하면 채팅 보기에 이유를 보이고 터미널 보기를 권한다. 터미널 보기는 이 파일과 무관하게 늘 동작한다.
2. **Codex 워크스페이스에는 채팅 보기가 없다.** 대화 기록 형식과 신호를 실측하지 못했다. 전환 버튼은 꺼져 있고 이유를 보인다.
3. **보이는 것은 지금 대화뿐이다.** 에이전트를 다시 시작하거나 `/clear` 하면 새 대화가 된다. 지난 대화는 보여주지 않는다.
4. **입력창에 쓴 글은 에이전트의 터미널에 써 넣는다.** 넣어도 되는 때만 입력창이 켜진다.
   - 쉬는 중, 작업 중: 켜짐. 작업 중에 보낸 글은 Claude Code 가 다음 차례에 읽는다(Task 1에서 실측).
   - 시작 중(폴더 신뢰 창이 떠 있을 수 있다), 상태 모름: 꺼짐. "터미널에서 확인이 필요합니다" 와 터미널로 가는 버튼을 보인다.
   - 승인 대기: 꺼짐. 대신 승인 카드를 보인다(5번).
   - 꺼짐: 입력창 자리에 "에이전트 시작" 버튼.
5. **승인 창은 채팅 안의 카드로 보인다.** 무엇을 하려는지(명령이나 파일)를 보이고 "허용", "거부", "터미널에서 보기" 버튼을 둔다. "허용" 은 터미널에 Enter, "거부" 는 Esc 를 보낸다. hook 으로 승인 창임이 확인된 동안에만 버튼이 켜진다(Task 1에서 실측).
6. **두레가 넣은 글은 내 말풍선으로 보이지 않는다.** TODO 변경 전달, 다른 워크스페이스의 메시지, 두레의 알림은 가운데의 작은 줄이나 카드로 보인다.
7. **에이전트 간 메시지는 두레가 가진 기록에서 가져와 시각 순서로 끼운다.** 보낸 것은 "○○에게 보냄", 받은 것은 "○○가 보냄" 카드. 첨부 자료는 펼쳐 볼 수 있다. 오른쪽 패널의 "대화" 탭은 그대로 둔다(프로젝트 전체의 대화를 스레드별로 보는 곳).
8. **보기 전환은 워크스페이스 화면 머리의 "터미널 | 채팅" 스위치다.** 고른 보기는 워크스페이스별로 기억한다(앱을 다시 켜도 유지).

## Global Constraints

- 1~3B단계 계획의 Global Constraints 전부.
- 채팅 보기는 터미널 보기를 대체하지 않는다. 채팅 보기에 문제가 있어도 에이전트와 터미널 보기는 영향받지 않는다.
- 대화 기록 파일은 읽기만 한다. 쓰거나 지우지 않는다. 읽는 경로는 hook 이 알려준 경로뿐이고, 그 경로가 `~/.claude/` 아래가 아니면 읽지 않는다.
- 터미널에 쓰는 것은 3A단계의 원칙을 따른다: 선택 창이 떠 있을 수 있는 상태에서는 쓰지 않는다. 사용자가 입력창에서 보낸 글은 사용자 입력으로 친다(왕복 횟수를 다시 센다).
- 에이전트와 사용자가 쓴 글은 화면에 글자로만 그린다. HTML 로 넣지 않는다(`dangerouslySetInnerHTML` 금지). 마크다운의 링크는 누를 수 없는 글자로 그린다.
- 기록 파일은 크다(짧은 대화도 수백 KB). 처음부터 다시 읽지 않고 읽은 자리부터 이어 읽는다. 화면에는 필요한 항목만 보낸다.
- 화면 글은 한국어다.
- 작업은 `feat/dure-v1-chat` 브랜치(`.worktrees/chat`)에서 한다. 검증용 인스턴스는 데이터 폴더를 분리해 띄우고 프로젝트 이름에 "검증용" 을 넣는다.
- 실제 에이전트를 쓰는 것은 Task 1 실험과 Task 6 손 확인이다(Claude Code 세션 몇 개, ⚠️ 토큰을 쓴다).

## Review Focus

1. 기록 파일에 모르는 종류의 줄, 깨진 줄(쓰는 도중 읽음), 아주 긴 줄이 있다. 채팅 보기가 멈추거나 항목이 뒤섞이면 안 된다. (Task 2)
2. 에이전트가 승인 창이나 폴더 신뢰 창을 띄운 상태에서 사용자가 채팅 입력창으로 글을 보낸다. 그 창에 글이 들어가면 안 된다. (Task 4)
3. 에이전트가 쓴 글이나 도구 결과에 HTML, 스크립트, 아주 긴 한 줄, 수천 줄짜리 출력이 있다. 화면이 깨지거나 느려지면 안 된다. (Task 5)
4. 두레가 넣은 글(TODO 변경, 메시지)과 사용자가 직접 쓴 글이 섞여 온다. 두레의 것이 내 말풍선으로 보이면 안 되고, 내 것이 두레의 것으로 보여도 안 된다. (Task 2)
5. 에이전트를 다시 시작하거나 대화를 비우거나 압축한다. 지난 대화의 항목이 새 대화에 섞여 남으면 안 된다. (Task 3)

## File Structure

```
src/shared/types.ts                  ChatItem, ChatStep, ChatSnapshot
src/core/chat/transcript.ts          기록 파일의 한 줄을 뜻 있는 조각으로 (순수 함수)
src/core/chat/timeline.ts            조각들을 대화 항목으로 묶기 (순수 함수)
src/core/chat/chatService.ts         파일 이어 읽기, 워크스페이스별 대화 상태, 입력 보내기, 승인 응답
src/core/hooks.ts, src/core/index.ts hook 이 준 기록 경로를 chatService 에 넘기기
src/core/workspaceService.ts         sendUserInput, answerPermission
src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts   chat.* 채널, 'chat' 주제
src/renderer/chatView.ts             화면용 순수 함수 (마크다운 조각내기, 요약 문구, 시간 표시)
src/renderer/components/ChatPane.tsx 채팅 보기
src/renderer/components/Markdown.tsx 글자만으로 그리는 마크다운
src/renderer/components/WorkspaceView.tsx   "터미널 | 채팅" 스위치
tests/core/transcript.test.ts, timeline.test.ts, chatService.test.ts, tests/renderer/chatView.test.ts
tests/fixtures/transcript-*.jsonl    실제 기록에서 뽑아 줄인 표본
spikes/14-chat-source.mjs
```

---

### Task 1: 재료와 입력 실험

**Files:**
- Create: `spikes/14-chat-source.mjs`, `tests/fixtures/transcript-basic.jsonl`
- Modify: `docs/superpowers/findings/2026-11-11-agent-wiring.md`

실험 코드는 버리는 코드라 테스트를 붙이지 않는다. 한 세션에서 차례로 한다.

- [ ] **Step 1: 기록이 쓰이는 때.** 긴 답을 시키고(예: "1부터 30까지 한 줄에 하나씩 한글로 써라") 기록 파일의 크기와 줄 수를 0.5초마다 잰다. 에이전트의 글이 쓰는 도중에 조금씩 기록되는지, 한 덩어리가 끝난 뒤에 기록되는지 기록한다. 도구 실행은 시작할 때(`tool_use`)와 끝날 때(`tool_result`) 각각 언제 기록되는지 hook 시각과 비교한다.
- [ ] **Step 2: 프롬프트가 기록되는 모양.** 다음 네 가지로 프롬프트를 넣고 기록의 `user` 줄을 비교한다: 터미널에 한 줄을 쳐서, 여러 줄을 붙여 넣어서, 두레 방식(`[두레]` 로 시작하는 여러 줄 붙여 넣기)으로, 실행 인자(첫 프롬프트)로. 본문 모양(`<pasted_content>` 감싸임 여부)과 구분에 쓸 수 있는 필드(`promptSource`, `origin`, `isMeta` 등)의 값을 표로 기록한다. hook 이 넣은 글(`PostToolUse` 의 `additionalContext`, `Stop` 의 block 이유, `SessionStart` 의 글)이 어떤 줄로 기록되는지도 기록한다.
- [ ] **Step 3: 작업 중에 보낸 글.** 20초쯤 걸리는 일을 시키고 도중에 한 줄을 쳐서 Enter 한다. 그 글이 버려지지 않고 다음 차례에 읽히는지, 기록에는 언제 어떤 줄로 나타나는지 기록한다.
- [ ] **Step 4: 승인 창.** `--permission-mode acceptEdits` 에서 승인이 필요한 명령을 시킨다. 그 순간의 `PreToolUse` hook 본문(도구 이름과 입력)과 `Notification` 을 남기고, 화면을 읽어 커서가 "1. Yes" 에 있음을 확인한 뒤 `\r` 을 보내 실행되는지 본다. 한 번 더 시켜 이번에는 `\x1b` 로 거부되는지, 그 뒤 어떤 hook 과 기록 줄이 오는지 기록한다. 승인 창의 선택지 구성이 명령에 따라 달라지는지(2번이 "다시 묻지 않기" 인 경우 등) 본 대로 기록한다.
- [ ] **Step 5: 대화가 바뀌는 때.** `/compact` 와 `/clear` 를 각각 실행하고, hook 이 주는 기록 경로와 세션 id 가 바뀌는지, 같은 파일에 이어 쓰는지 기록한다. 압축 요약 줄의 표시(`isCompactSummary` 등)를 기록한다.
- [ ] **Step 6: 표본 만들기.** 이 세션의 기록에서 `user`, `assistant` 줄과 채팅에 필요한 그 밖의 줄만 남기고, 긴 글은 줄여 `tests/fixtures/transcript-basic.jsonl` 로 저장한다. 계정 식별자, 세션 주소, 실제 경로의 사용자 이름은 가짜 값으로 바꾼다. 필요 없는 큰 줄(`api-request*`, `attachment` 의 시스템 글)은 종류별로 한두 줄만 남긴다(모르는 줄을 건너뛰는지 시험하기 위해).
- [ ] **Step 7: 결과 문서에 15~15e 행을 더하고 커밋.** `chore: spike chat view sources and input paths`
- [ ] **Step 8: 전제 확인.** 다음 중 하나라도 ❌ 면 멈추고 사용자에게 보고한다: 기록에서 사용자 글·에이전트 글·도구 호출·결과를 시각과 함께 읽을 수 있다 / 두레가 넣은 글과 사용자가 넣은 글을 구분할 수 있다 / 작업 중에 보낸 글이 버려지지 않는다. 승인 창을 `\r`/`\x1b` 로 답하는 것이 ❌ 면 승인 카드의 버튼은 "터미널에서 보기" 만 남긴다(멈추지 않는다).

---

### Task 2: 기록 읽기와 대화 항목 만들기 (순수 함수)

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/core/chat/transcript.ts`, `src/core/chat/timeline.ts`
- Test: `tests/core/transcript.test.ts`, `tests/core/timeline.test.ts`

**Interfaces:**
- Consumes: Task 1의 실측(필드 이름과 값), `tests/fixtures/transcript-basic.jsonl`.
- Produces:

```ts
// src/shared/types.ts
export interface ChatStep {
  id: string;                        // 도구 호출 id
  tool: string;                      // Bash, Edit, Read, mcp__dure__todo_add …
  summary: string;                   // 한 줄 요약 (예: "git status", "LoginForm.tsx 수정")
  input: string;                     // 입력 원문 (명령, 파일 경로와 바뀐 내용 등). 최대 20_000자
  output: string | null;             // 결과 원문. 아직 없으면 null. 최대 20_000자
  status: 'running' | 'done' | 'error' | 'denied';
  startedAt: number; endedAt: number | null;
}
export type ChatItem =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string }
  | { kind: 'steps'; id: string; at: number; steps: ChatStep[] }
  | { kind: 'dure'; id: string; at: number; title: string; text: string }       // 두레가 넣은 글
  | { kind: 'notice'; id: string; at: number; text: string };                    // 중단됨, 대화가 압축됨 등

// src/core/chat/transcript.ts
export type Piece =
  | { type: 'prompt'; id: string; at: number; text: string; from: 'user' | 'dure' }
  | { type: 'text'; id: string; at: number; text: string }
  | { type: 'tool-start'; id: string; at: number; tool: string; input: unknown }
  | { type: 'tool-end'; id: string; at: number; output: string; error: boolean; denied: boolean }
  | { type: 'hook-context'; id: string; at: number; text: string }               // hook 이 넣은 글
  | { type: 'interrupted'; id: string; at: number }
  | { type: 'compacted'; id: string; at: number };
/** 기록 파일의 한 줄을 조각들로. 모르는 줄, 깨진 줄, 하위 에이전트의 줄은 빈 배열. 던지지 않는다. */
export function parseLine(line: string): Piece[];
export function stepSummary(tool: string, input: unknown): string;

// src/core/chat/timeline.ts
/** 조각을 차례로 받아 대화 항목 목록을 유지한다. */
export class Timeline {
  push(pieces: Piece[]): void;
  items(): ChatItem[];
  reset(): void;
}
```

규칙:

- `parseLine` 은 `type` 이 `user`, `assistant` 인 줄과 Task 1에서 필요하다고 확인한 줄만 본다. JSON 이 아니면 빈 배열. 하위 에이전트의 줄(`isSidechain`)은 빈 배열.
- 프롬프트가 두레의 것인지는 Task 1에서 확인한 방법으로 가린다. 글 앞머리만으로 정해야 한다면: `<pasted_content …>` 감싸기를 벗긴 뒤 `[두레]` 로 시작하면 `dure`. 감싸기는 화면에 보이지 않게 벗긴다.
- `stepSummary`: `Bash` 는 명령의 첫 줄(최대 80자), `Read`/`Edit`/`Write` 는 파일 이름과 동작(`LoginForm.tsx 읽음`, `… 수정`, `… 만듦`), `Grep`/`Glob` 은 찾는 말, `mcp__dure__*` 는 두레 동작의 한국어 이름(`TODO 추가`, `메시지 보냄`, `자료 올림`, `커밋 메시지 저장` 등), 그 밖은 도구 이름 그대로.
- `Timeline`:
  - 에이전트의 글과 글 사이에 낀 연속된 도구 호출은 `steps` 항목 하나로 묶는다. 글이 나오면 묶음이 끝난다.
  - `tool-end` 는 같은 id 의 단계에 결과와 상태를 채운다. 거부된 것은 `denied`, 오류는 `error`.
  - `prompt` 가 `dure` 면 `dure` 항목(제목은 첫 줄에서 `[두레] ` 를 뗀 것, 본문은 나머지). `hook-context` 도 `[두레]` 로 시작하면 `dure` 항목, 아니면 버린다(다른 도구의 hook 글).
  - `interrupted` 는 `notice` "중단됨", `compacted` 는 `notice` "대화가 압축됨. 이 위의 내용은 에이전트가 요약해서 기억합니다.".
  - 항목 id 는 기록의 줄 id 에서 온다. 같은 조각을 두 번 넣어도 항목이 겹치지 않는다.
  - 입력과 출력 원문은 20_000자를 넘으면 자르고 끝에 `… (N자 생략)` 을 붙인다.

- [ ] **Step 1: 실패하는 테스트 작성.** 표본 파일과 손으로 만든 줄을 함께 쓴다.

```ts
// transcript.test.ts
test('사용자가 친 프롬프트는 from user', () => {});
test('두레가 넣은 프롬프트는 from dure 이고 감싸기가 벗겨진다', () => {});
test('에이전트의 글, 도구 호출, 도구 결과를 조각으로 낸다', () => {});
test('거부된 도구 결과는 denied, 오류는 error', () => {});
test('모르는 종류의 줄, JSON 이 아닌 줄, 잘린 줄, 빈 줄은 빈 배열이고 던지지 않는다', () => {});
test('하위 에이전트의 줄은 빈 배열', () => {});
test('표본 파일 전체를 읽어도 던지지 않고 프롬프트 수가 맞다', () => {});
test.each([...])('stepSummary(%s) = %s', () => {});   // Bash, Read, Edit, Write, Grep, mcp__dure__todo_add, mcp__dure__message_send, 모르는 도구

// timeline.test.ts
test('글 사이의 연속된 도구 호출은 steps 하나로 묶인다', () => {});
test('도구 결과가 오면 같은 단계가 done 이 되고 출력이 채워진다', () => {});
test('아직 결과가 없는 단계는 running', () => {});
test('두레의 프롬프트와 [두레] hook 글은 dure 항목, 다른 hook 글은 버린다', () => {});
test('중단과 압축은 notice 가 된다', () => {});
test('같은 조각을 두 번 넣어도 항목이 겹치지 않는다', () => {});
test('긴 출력은 20000자에서 잘리고 생략 표시가 붙는다', () => {});
test('reset 뒤에는 비어 있다', () => {});
test('표본 파일로 만든 항목의 순서: user → (steps) → assistant …', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): parse agent transcripts into chat items`

---

### Task 3: 대화 서비스

**Files:**
- Create: `src/core/chat/chatService.ts`
- Modify: `src/core/hooks.ts`, `src/core/index.ts`, `src/core/workspaceService.ts`, `src/shared/types.ts`
- Test: `tests/core/chatService.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/types.ts
export interface ChatSnapshot {
  available: boolean;                // 이 워크스페이스에 채팅 보기를 쓸 수 있는가
  reason: string | null;             // 쓸 수 없으면 이유 (Codex, 아직 대화 기록이 없음, 읽을 수 없음)
  items: ChatItem[];
  workingSince: number | null;       // 지금 차례가 시작된 시각 (작업 중일 때)
  pendingPermission: { tool: string; summary: string; input: string } | null;   // 승인 대기 중인 것
}

// src/core/chat/chatService.ts
export class ChatService extends EventEmitter {
  /** hook 이 올 때마다 부른다. 기록 경로를 알아 두고 새 줄을 읽는다. */
  noteHook(workspaceId: string, event: string, payload: unknown): void;
  snapshot(workspaceId: string): ChatSnapshot;
  /** 에이전트 터미널이 끝났다 */
  agentExited(workspaceId: string): void;
  forget(workspaceId: string): void;
  dispose(): void;
  // 이벤트: 'changed' (workspaceId)
}
```

규칙:

- 기록 경로는 hook 본문의 `transcript_path` 에서 얻는다. `~/.claude/` 아래의 `.jsonl` 파일이 아니면 무시한다(실제 경로로 풀어 확인한다).
- 경로가 바뀌면(새 대화) 타임라인을 비우고 새 파일을 처음부터 읽는다. `SessionStart` 의 `source` 가 `clear` 여도 비운다.
- 읽기: 워크스페이스마다 읽은 자리(바이트)를 기억하고 그 뒤만 읽는다. 마지막 줄이 줄바꿈으로 끝나지 않으면 그 줄은 다음에 읽는다. 파일이 줄어들었으면 처음부터 다시 읽는다.
- 읽는 때: hook 이 올 때마다. 그리고 상태가 `working` 인 동안에는 1초마다(에이전트의 글은 hook 없이 기록될 수 있다). 쉬는 중에는 주기적으로 읽지 않는다.
- `workingSince`: `UserPromptSubmit` 때 그 시각, `Stop` 이나 에이전트 종료 때 null.
- `pendingPermission`: `PreToolUse` 본문의 도구와 입력을 기억해 두었다가, 승인 요청 알림(`Notification` 의 `permission_prompt`)이 오면 그것을 `pendingPermission` 으로 한다. 다음 `PostToolUse`, `Stop`, `UserPromptSubmit`, 에이전트 종료 때 null.
- Codex 워크스페이스: `available: false`, 이유 `Codex 는 아직 채팅 보기를 지원하지 않습니다. 터미널 보기를 쓰세요.`. 기록 경로를 아직 모르면 `available: true` 에 항목이 비어 있다(에이전트가 꺼져 있거나 막 시작했다).
- 파일을 읽다 오류가 나면 던지지 않고 `available: false`, 이유 `대화 기록을 읽을 수 없습니다. 터미널 보기를 쓰세요.` 로 한다.
- 코어의 hook 처리(`onHook`)가 `chat.noteHook` 을 부른다. 에이전트 터미널 종료와 워크스페이스 삭제도 잇는다.

- [ ] **Step 1: 실패하는 테스트 작성.** 임시 폴더를 `~/.claude` 인 것처럼 주입할 수 있게 `ChatService` 생성자에 허용 뿌리 경로를 받는다.

```ts
test('hook 의 transcript_path 로 파일을 읽어 항목을 만든다', () => {});
test('파일에 줄이 더해지면 다음 hook 에서 새 줄만 읽는다', () => {});
test('줄바꿈으로 끝나지 않은 마지막 줄은 다음에 읽는다', () => {});          // Review Focus 1
test('허용 뿌리 밖의 경로와 .jsonl 이 아닌 경로는 읽지 않는다', () => {});
test('기록 경로가 바뀌면 지난 항목이 사라진다', () => {});                   // Review Focus 5
test('SessionStart source clear 면 항목이 비워진다', () => {});
test('작업 중에는 hook 없이도 1초마다 새 줄을 읽는다', async () => {});
test('workingSince: UserPromptSubmit 에 시작, Stop 에 끝', () => {});
test('pendingPermission: PreToolUse 뒤 승인 알림이 오면 채워지고 PostToolUse 에 비워진다', () => {});
test('Codex 워크스페이스는 available false 와 이유', () => {});
test('파일이 사라지면 던지지 않고 available false', () => {});
test('changed 이벤트가 항목이 바뀔 때만 난다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트 통과 확인.**
- [ ] **Step 3: 커밋.** `feat(core): add chat service that tails agent transcripts`

---

### Task 4: 채팅에서 보내기와 승인 응답

**Files:**
- Modify: `src/core/workspaceService.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`
- Test: `tests/core/workspaceService.test.ts`, `tests/core/ipcContract.test.ts`

**Interfaces:**
- Produces:

```ts
// WorkspaceService
canSendInput(id: string): boolean;                       // status 가 idle 또는 working 이고 에이전트 터미널이 살아 있다 (Claude Code 만)
sendUserInput(id: string, text: string): Promise<void>;  // 사용자가 채팅 입력창에서 보낸 글
answerPermission(id: string, answer: 'allow' | 'deny'): void;

// DureApi
chat: {
  get(workspaceId: string): Promise<ChatSnapshot & { canSend: boolean }>;
  send(workspaceId: string, text: string): Promise<void>;
  answerPermission(workspaceId: string, answer: 'allow' | 'deny'): Promise<void>;
};
// ChangeTopic 에 'chat'
```

규칙:

- `sendUserInput`: `canSendInput` 이 거짓이면 오류 `지금은 채팅으로 보낼 수 없습니다. 터미널을 확인하세요.`. 글의 제어 문자를 지운다(줄바꿈 제외). 한 줄이면 글자를 그대로 쓰고 400ms 뒤 `\r`, 여러 줄이면 붙여넣기 묶음(`\x1b[200~` … `\x1b[201~`) 뒤 400ms 후 `\r`. 사용자 입력이므로 쉬는 중 확인을 지우고(`noteTerminalInput` 과 같다), 두레가 넣은 프롬프트로 표시하지 않는다.
- `status` 가 `starting`, `waiting_user`, `stopped` 이거나 Codex 면 보내지 않는다(Review Focus 2).
- `answerPermission`: 상태가 `waiting_user` 이고 대화 서비스에 `pendingPermission` 이 있을 때만 쓴다. `allow` 는 `\r`, `deny` 는 `\x1b`. 그 밖에는 아무것도 쓰지 않고 오류 `승인을 기다리는 중이 아닙니다.`.
- Task 1 Step 4에서 `\r` 로 승인되지 않는 것으로 확인되면 `answerPermission` 과 그 채널은 만들지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('sendUserInput: 쉬는 중이면 글이 터미널에 들어가고 Enter 가 따라온다', async () => {});
test('sendUserInput: 여러 줄은 붙여넣기 묶음으로 들어간다', async () => {});
test('sendUserInput: 시작 중, 승인 대기, 꺼짐, Codex 면 오류이고 터미널에 아무것도 쓰지 않는다', async () => {});   // Review Focus 2
test('sendUserInput 으로 보낸 글의 UserPromptSubmit 은 사용자 개입으로 친다', async () => {});
test('sendUserInput: 제어 문자는 지워진다', async () => {});
test('answerPermission: 승인 대기 중이면 allow 는 CR, deny 는 ESC 를 쓴다', async () => {});
test('answerPermission: 승인 대기 중이 아니면 오류이고 아무것도 쓰지 않는다', async () => {});
test('IPC_CHANNELS 에 chat.get, chat.send, chat.answerPermission 이 있다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사 통과 확인.**
- [ ] **Step 3: 커밋.** `feat: send chat input and permission answers to the agent terminal`

---

### Task 5: 채팅 화면

**Files:**
- Create: `src/renderer/chatView.ts`, `src/renderer/components/ChatPane.tsx`, `src/renderer/components/Markdown.tsx`
- Modify: `src/renderer/components/WorkspaceView.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/chatView.test.ts`

**Interfaces:**
- Produces:

```ts
// src/renderer/chatView.ts
export type Block =
  | { type: 'p'; text: string } | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: string[] } | { type: 'heading'; level: number; text: string }
  | { type: 'table'; rows: string[][] };
export function toBlocks(markdown: string): Block[];
export type Inline = { text: string; code?: boolean; bold?: boolean };
export function toInline(text: string): Inline[];
export function stepsLabel(steps: ChatStep[]): string;         // "명령 3개 실행함", "명령 2개 실행 중…", "파일 1개 읽음" 등
export function elapsed(ms: number): string;                    // "45초", "3분 12초", "1시간 5분"
export type Entry = ChatItem | { kind: 'peer'; id: string; at: number; direction: 'sent' | 'received'; message: Message };
/** 대화 항목과 에이전트 간 메시지를 시각 순서로 합친다. 메시지 전달을 알리는 dure 항목과 겹치는 것은 메시지 카드 하나로 줄인다. */
export function mergeEntries(items: ChatItem[], messages: Message[], workspaceId: string): Entry[];
```

화면 규칙 (사용자가 보여준 화면을 따른다. 두레의 색과 말씨는 TODO 패널과 맞춘다):

- 워크스페이스 화면 머리에 스위치 "터미널 | 채팅". 고른 보기는 워크스페이스별로 `localStorage` 에 기억한다. 처음은 터미널. Codex 는 "채팅" 이 꺼져 있고 툴팁에 이유.
- 채팅을 고르면 터미널 탭 자리에 채팅이 보인다. 터미널 프로세스는 그대로 살아 있고, 다시 터미널을 고르면 그 내용이 이어져 보인다. 오른쪽 패널(TODO | 대화)은 그대로다.
- 대화는 가운데 한 줄(최대 폭 780px)로 흐른다.
  - `user`: 오른쪽 말풍선.
  - `assistant`: 왼쪽에 테두리 없는 글. 마크다운을 그린다(문단, 제목, 목록, 표, 코드 블록, 굵게, `코드`). 링크는 글자 그대로.
  - `steps`: 접힌 한 줄(`stepsLabel` + 끝났으면 ✓, 하는 중이면 도는 표시). 누르면 단계가 한 줄씩 펼쳐진다(상태 표시, `summary`, 걸린 시간). 단계 줄을 누르면 입력과 출력 원문이 고정폭 글자로 펼쳐진다(각각 최대 높이 320px, 넘으면 그 안에서 스크롤). 거부는 "거부함", 오류는 붉은 표시.
  - `dure`: 가운데 정렬된 작은 줄(제목). 누르면 본문이 펼쳐진다.
  - `peer`: 카드. 보낸 것은 "○○에게 보냄", 받은 것은 "○○가 보냄". 본문과 첨부 자료(펼치기). 전달 대기 중이면 그 표시.
  - `notice`: 가운데 가는 줄.
- 대화 위쪽(스크롤해도 고정)에 지금 상태 한 줄: 작업 중이면 도는 표시와 `N분 M초 작업 중` + "멈춤" 버튼, 쉬는 중이면 아무것도 없다.
- 맨 아래 입력창(여러 줄, Enter 로 보내기, Shift+Enter 로 줄바꿈).
  - `canSend` 가 참이면 켜짐. 작업 중이면 안내 `작업 중에 보내면 다음 차례에 읽습니다`.
  - 승인 대기면 입력창 대신 승인 카드: `summary` 와 입력 원문, "허용", "거부", "터미널에서 보기".
  - 시작 중이거나 보낼 수 없으면 입력창이 꺼지고 `터미널에서 확인이 필요합니다` 와 "터미널로" 버튼.
  - 에이전트가 꺼져 있으면 "에이전트 시작" 버튼.
- 새 항목이 오면 맨 아래로 따라간다. 사용자가 위로 올려 읽는 중이면 따라가지 않고 "새 내용 ↓" 버튼을 보인다.
- 항목이 많아도 버벅이지 않게, 접힌 단계의 원문은 펼칠 때만 그린다. 원문은 화면에서 한 번 더 20_000자로 자른다.
- `available` 이 거짓이면 대화 자리에 이유와 "터미널 보기로" 버튼.
- `onChanged('chat')`, `'workspaces'`, `'messages'` 를 받으면 다시 읽는다.

- [ ] **Step 1: 실패하는 테스트 작성.**

```ts
test('toBlocks: 문단, 제목, 목록, 번호 목록, 코드 블록(언어), 표', () => {});
test('toBlocks: 닫히지 않은 코드 블록(쓰는 중)도 코드로 본다', () => {});
test('toInline: `코드`, **굵게**, 섞인 경우, 짝이 안 맞는 표시는 글자 그대로', () => {});
test('toBlocks/toInline: <script>, <img onerror> 는 글자 그대로 남는다 (HTML 로 해석하지 않는다)', () => {});   // Review Focus 3
test('stepsLabel: 전부 끝남, 하는 중, 한 종류만일 때의 문구', () => {});
test('elapsed: 45초, 3분 12초, 1시간 5분', () => {});
test('mergeEntries: 시각 순서로 합치고, 보낸 것과 받은 것을 구분한다', () => {});
test('mergeEntries: 메시지 전달을 알리는 dure 항목은 그 메시지 카드로 대신한다', () => {});
test('mergeEntries: 다른 워크스페이스끼리의 메시지는 넣지 않는다', () => {});
```

- [ ] **Step 2: 실패 확인 → 구현 → 전체 테스트·타입 검사·빌드 통과 확인.**
- [ ] **Step 3: 화면 확인 (에이전트 없이).** 검증용 인스턴스에서, 표본 기록 파일을 hook 으로 알려 주어 채팅 보기를 채운다. 스크린샷으로 본다: 말풍선과 글, 접힌 단계와 펼친 단계와 원문, 두레 줄, 메시지 카드, 승인 카드, 입력창의 네 상태, 긴 출력, 표와 코드 블록. 사용자가 보여준 화면과 견주어 스스로 비평하고 고친다.
- [ ] **Step 4: 커밋.** `feat(renderer): add chat view`

---

### Task 6: 실제 에이전트로 확인

- [ ] **Step 1: 준비.** 검증용 인스턴스에 임시 저장소 둘로 프로젝트 "검증용 (채팅 보기)" 와 Claude Code 워크스페이스 둘("프론트", "백엔드")을 만든다.
- [ ] **Step 2: 장면.** 화면을 읽어 확인한 뒤에만 입력한다. 결과를 항목별로 사용자에게 보고한다.
  1. "프론트" 를 터미널 보기로 시작해 폴더 신뢰 창을 넘긴 뒤 채팅 보기로 바꾼다. 입력창이 켜지는가.
  2. 채팅 입력창으로 일을 시킨다(파일을 읽고 고치는 일). 내 말풍선, 접힌 단계 줄, 에이전트의 글이 차례로 보이는가. 단계를 펼치면 명령과 출력이 보이는가. 위쪽에 작업 시간이 흐르는가.
  3. 작업 중에 채팅으로 한마디 더 보낸다. 버려지지 않고 반영되는가.
  4. 승인이 필요한 명령을 시킨다. 승인 카드가 뜨는가. "허용" 으로 진행되는가. 한 번 더 시켜 "거부" 로 멈추는가.
  5. "백엔드에 ○○를 물어봐라" 라고 시킨다. 보낸 메시지와 받은 답장이 프론트의 채팅 흐름 안에 카드로 보이는가. 백엔드의 채팅에도 반대 방향으로 보이는가.
  6. 터미널 보기로 바꿨다가 돌아온다. 대화가 그대로인가. 터미널에도 같은 내용이 있는가.
  7. 패널에서 TODO 를 고친다. 채팅에 "두레가 전달" 줄로 보이고 내 말풍선으로 보이지 않는가.
  8. `/compact` 뒤 "대화가 압축됨" 줄이 보이는가. 에이전트를 껐다 켜면 새 대화로 시작하는가.
- [ ] **Step 3: 설계 문서에 7.10 절을 쓴다.** "사용자가 정한 것", "이 계획이 정한 것", Task 1 실측, 확인 결과, 한계(Claude Code 내부 형식에 기대는 점, Codex 미지원, 지금 대화만).
- [ ] **Step 4: 커밋.** `docs: record chat view design and verification`
