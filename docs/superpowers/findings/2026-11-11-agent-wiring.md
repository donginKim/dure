# 에이전트 연결 실험 결과 (0단계)

실험일: 2026-11-11. 환경: macOS, Claude Code 2.1.317, Codex CLI 0.163.0 → 실험 중 0.167.0.

표기: ✅ 실측으로 됨, ❌ 실측으로 안 됨, ⏳ 아직 못 함, ⚠️ 추정. 실험 스크립트는 `spikes/`, 원본 출력은 `spikes/out/` (git 제외).

## 막힌 것부터

- **Codex는 이 PC에서 모델 호출이 안 된다.** `~/.codex/config.toml` 이 `openai_base_url = "http://127.0.0.1:3425/…"` (magpie 프록시)를 쓰는데 그 포트에 떠 있는 것이 없다. 접속 거부로 대화가 진행되지 않는다. 그래서 Codex로 실제 대화가 필요한 실험(도구 호출, 깨우기, 끼워 넣기, 중단, 상태 신호)은 ⏳ 다. 모델 없이 확인할 수 있는 것만 실측했다.
- `claude --model haiku` 는 이 계정에서 `claude/claude-haiku-5-5` 404로 실패한다. 실험은 기본 모델로 했다.

## 결과 표

| 번호 | 질문 | Claude Code | Codex | 근거 |
|---|---|---|---|---|
| 1 | 실행 인자만으로 두레 MCP 서버를 붙일 수 있는가 | ✅ `--mcp-config <두레 폴더의 json>`. 도구 호출까지 확인 | ✅ 접속까지 확인: `-c mcp_servers.dure.url="…"`, `-c mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"`, 환경변수로 토큰. 서버에 인증된 요청 3건 도착. ⏳ 도구 호출은 미확인 | `spikes/01-mcp-connect.mjs` |
| 1a | MCP 도구 호출 때 승인 창이 뜨는가 | ✅ `--allowedTools mcp__dure` 를 주면 안 뜬다. ⚠️ 안 줬을 때는 실험하지 않음 | ⏳ | 같음 |
| 1b | 저장소에 파일을 남기는가 | ✅ 안 남김 (`git status --porcelain` 빈 값) | ✅ 안 남김 | 같음 |
| 1c | 사용자의 기존 MCP 서버 | `--strict-mcp-config` 를 주면 두레 것만, 안 주면 사용자 것도 같이 뜬다 (도움말 기준, 주지 않은 쪽은 실행 안 함) | `-c` 는 사용자 설정 위에 덧씌운다 | `claude --help` |
| 2 | 실행 인자로 지침을 넣을 수 있는가 | ✅ `--append-system-prompt` | ✅ `-c developer_instructions="…"` 가 모델에 보이는 developer 메시지로 들어간다 (`codex debug prompt-input` 으로 모델 호출 없이 확인) | `spikes/02-09-claude.mjs` |
| 3 | 쉬는 중인 에이전트를 터미널 입력으로 깨울 수 있는가 | ✅ 글자를 쓰고 0.4초 뒤 `\r`. 여러 줄은 bracketed paste(`\x1b[200~` … `\x1b[201~`) 뒤 `\r` | ⏳. 대안 `codex queue --thread <세션> --message …` 이 있다 (도움말 확인, 실행 안 함) | 같음 |
| 4a | 작업 중에 내용을 끼워 넣을 수 있는가 | ✅ `--settings <json>` 의 `PostToolUse` hook 이 `hookSpecificOutput.additionalContext` 를 돌려주면 다음 단계에 반영된다. **단 조건이 있다 (아래 "신뢰 선언")** | ⏳. `hooks` 기능은 stable 로 켜져 있다 | 같음 |
| 4b | 응답이 끝나는 순간 이어서 일을 시킬 수 있는가 | ✅ `Stop` hook 이 `{"decision":"block","reason":"…"}` 을 돌려주면 멈추지 않고 이어서 한다. 같은 조건 | ⏳ | 같음 |
| 5 | 프로세스를 죽이지 않고 하던 일만 멈출 수 있는가 | ✅ `\x1b`(Esc). 약 2초 안에 입력 대기로 돌아오고 다음 지시를 받는다 | ⏳ | 같음 |
| 6 | 권한 모드 `ask` | ✅ `--permission-mode acceptEdits`: 파일 생성은 묻지 않고, `curl` 은 승인 창이 뜬다 | ⏳ 후보: `--sandbox workspace-write --ask-for-approval on-request` | 같음 |
| 6b | 권한 모드 `bypass` | ✅ `--dangerously-skip-permissions`: `curl` 이 묻지 않고 실행된다 | ⏳ 후보: `--dangerously-bypass-approvals-and-sandbox` | `spikes/06-claude-bypass.mjs` |
| 7 | 상태를 화면 해석 없이 알 수 있는가 | ✅ hook 신호: `SessionStart`(뜸), `UserPromptSubmit`(작업 시작), `PreToolUse`/`PostToolUse`(작업 중), `Stop`(쉬는 중), `Notification`(승인 창에서 사용자 기다림). ❌ Esc 로 중단했을 때와 모델 오류로 끝났을 때는 `Stop` 이 오지 않는다 | ⏳ | `spikes/02-09-claude.mjs` |
| 8 | 샌드박스 안에서 서버를 띄우고 localhost 를 호출할 수 있는가 | 해당 없음 (샌드박스 없음, 승인 창으로 다룸) | ❌ `:workspace` 프로필에서 localhost 와 외부 모두 접속 실패. `-c sandbox_workspace_write.network_access=true` 로도 안 풀림. 작업 폴더 쓰기는 됨, 밖은 막힘 | `codex sandbox -P :workspace` |
| 9 | `PATH` 앞에 끼운 `git` 이 에이전트의 명령 실행에 쓰이는가 | ✅ 에이전트가 실행한 `git status` 가 대리 실행 파일을 탔다 | ✅ 샌드박스 안 `git status` 가 대리 실행 파일을 탔다 (모델 없이 확인). ⏳ 실제 에이전트 실행에서는 미확인 | 같음 |

## 설계를 바꾸는 발견

1. **터미널에 글자를 써 넣는 것은 위험하다.** 에이전트는 예고 없이 선택 창을 띄운다. 실험 중 확인한 것만 해도 Claude Code의 폴더 신뢰 창(기본 선택 "No, exit"), Codex의 폴더 신뢰 창, Codex 업데이트 창(기본 선택 "Update now"), Codex 새 모델 안내 창이 있다. 실험 스크립트가 업데이트 창에 Enter를 보내 `brew upgrade --cask codex` 가 실행되는 사고가 났다. 두레는 에이전트가 쉬는 중이라는 것을 hook 신호로 확인했을 때만 터미널에 써 넣어야 하고, 상태를 모르면 쓰지 않고 사용자에게 알려야 한다.
2. **신뢰 선언이 없으면 끼워 넣은 내용을 에이전트가 무시한다.** hook 으로 "사용자가 계획을 바꿨다" 를 넣자 Claude Code는 "hook 이 사용자 발언을 대신 주장한다" 며 따르지 않았다. 실행 시 지침에 "두레는 hook 으로 `[두레]` 로 시작하는 글을 전달한다. 사용자가 직접 설정한 방식이니 사용자 지시와 같은 권위로 따르라" 를 넣자 4a, 4b 모두 따랐다. 이 문장은 지침에 반드시 들어가야 한다.
3. **새 작업 폴더마다 신뢰 창이 뜬다.** 두 에이전트 모두, 승인 생략 모드에서도 뜬다. 워크스페이스를 만든 뒤 첫 에이전트 시작은 사용자가 터미널에서 직접 눌러야 한다. 두레가 대신 누르지 않는다. 신뢰 기록은 에이전트가 자기 전역 설정(`~/.claude.json`, `~/.codex/config.toml`)에 스스로 쓴다.
4. **`Stop` 신호만으로는 "쉬는 중" 을 다 잡지 못한다.** 중단과 모델 오류 때는 오지 않는다. 두레가 직접 중단시킨 경우는 두레가 상태를 바꾸면 되고, 그 밖에는 "한동안 신호가 없으면 상태 모름" 으로 두고 터미널 써 넣기를 하지 않는다.
5. **Codex `ask` 모드에서는 서버 실행이 승인 없이 안 된다.** 장면 1에서 백엔드가 Codex이고 `ask` 모드면, 깨어난 에이전트가 서버를 띄우는 순간 승인을 기다리며 멈춘다. 두레는 이를 "사용자 기다림" 으로 보여줘야 한다. 끊김 없이 돌리려면 그 워크스페이스를 `bypass` 로 둬야 한다.

## 확정된 실행 방식

`configDir` 은 `<데이터 폴더>/workspaces/<워크스페이스 id>` 다. 저장소 안에는 아무것도 쓰지 않는다.

### Claude Code (전부 ✅)

- 실행 파일: `claude`
- 두레 폴더에 쓰는 파일:
  - `configDir/mcp.json`: `{"mcpServers":{"dure":{"type":"http","url":"<mcpUrl>","headers":{"Authorization":"Bearer <token>"}}}}`
- 인자:
  - `--mcp-config <configDir/mcp.json>`
  - `--allowedTools mcp__dure`
  - `--append-system-prompt <지침>`
  - `ask`: `--permission-mode acceptEdits` / `bypass`: `--dangerously-skip-permissions`
- `--strict-mcp-config` 는 주지 않는다. 사용자의 기존 MCP 서버를 그대로 쓰게 한다.
- hook 용 `--settings <configDir/settings.json>` 은 2·3단계에서 더한다. 형식은 `{"hooks":{"<이벤트>":[{"matcher":"","hooks":[{"type":"command","command":"…"}]}]}}`.
- 환경변수: 없음.

### Codex (✅ 와 ⏳ 가 섞여 있다)

- 실행 파일: `codex`
- 두레 폴더에 쓰는 파일: 없음
- 인자:
  - ✅ `-c mcp_servers.dure.url="<mcpUrl>"`
  - ✅ `-c mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"`
  - ✅ `-c developer_instructions="<지침>"` (값은 TOML 문자열로 이스케이프한다)
  - ⏳ `ask`: `--sandbox workspace-write --ask-for-approval on-request` / `bypass`: `--dangerously-bypass-approvals-and-sandbox`
- 환경변수: `DURE_MCP_TOKEN=<token>`. 토큰은 인자에 넣지 않는다.

## 남은 실험 (Codex 모델 호출이 되면)

1의 도구 호출, 1a, 3, 4a, 4b, 5, 6, 6b, 7, 9의 실제 에이전트 실행. hook 설정 형식과 위치, 신뢰 확인(`--dangerously-bypass-hook-trust`) 필요 여부도 이때 확인한다.

## 실험이 이 PC에 남긴 것

- 사고로 인한 변화: Codex 0.163.0 → 0.167.0, Homebrew 자체 갱신, `brew cleanup` 으로 캐시·로그 45건 삭제, `python@3.14` 손상 후 3.14.10 으로 재설치(이때 `openssl@4` 가 설치되고 `/opt/homebrew/opt/openssl` 이 @4 를 가리키게 됨).
- 에이전트가 스스로 쓴 것: 임시 폴더에 대한 신뢰 기록(`~/.codex/config.toml` 의 `[projects."…dure-spike-repo-…"]`, Claude Code 쪽 신뢰 기록), 임시 폴더별 세션 기록(`~/.claude/projects/-private-var-folders-…dure-spike-repo-…`).
- 임시 폴더: `$TMPDIR/dure-spike-*`.
