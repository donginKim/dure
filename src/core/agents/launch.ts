import { join } from 'node:path';
import type { AgentKind, PermissionMode } from '@shared/types';
import { gitShimScript } from './gitShim';

export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 실행 전에 써 둘 파일. 전부 configDir 아래다. 사용자 저장소에는 아무것도 쓰지 않는다. */
  files: { path: string; content: string; mode?: number }[];
}

export interface AgentLaunchInput {
  kind: AgentKind;
  permissionMode: PermissionMode;
  mcpUrl: string;
  /** hook 스크립트가 부르는 주소 (뒤에 /<이벤트> 가 붙는다) */
  hookUrl: string;
  token: string;
  configDir: string;
  instructions: string;
  /** 진짜 git 의 절대 경로. gitCommonDir 와 함께 주면 에이전트의 commit·push 를 막는 대리 실행 파일을 건다 */
  realGit?: string;
  /** 막을 저장소의 공용 .git 폴더 (실제 경로). 이 저장소들에 대한 commit·push 만 막는다. 조율 에이전트는 등록된 저장소 전부 */
  gitCommonDir?: string | string[];
  /**
   * 파일을 바꾸는 것을 저절로 허용하지 않는다 (Claude Code). 조율 에이전트에 쓴다:
   * acceptEdits 모드는 rm, mv, cp, sed 같은 셸 명령도 묻지 않고 실행하는데, 조율 에이전트는 사용자의 원본 저장소를 읽을 수 있다.
   */
  manualEdits?: boolean;
  /** 에이전트에게 물려줄 PATH. 대리 실행 파일 폴더를 이 앞에 붙인다 */
  basePath: string;
  /** 띄우자마자 실행할 프롬프트. 폴더 신뢰 창이 있으면 그 뒤에 실행된다 (실험 12) */
  initialPrompt?: string;
  /**
   * 터미널 화면 없이 구조화된 입출력으로 띄운다 (Claude Code 만. 실험 17, 18).
   * 이때 프롬프트는 인자가 아니라 표준 입력으로 보낸다.
   */
  headless?: boolean;
  /** 이어갈 대화의 id (headless 일 때) */
  resumeSessionId?: string;
  /** 설정에서 고른 모델 (Claude Code). 없으면 Claude Code 의 기본 */
  model?: string;
  /** 설정에서 고른 effort (Claude Code). 없으면 Claude Code 의 기본 */
  effort?: string;
  /** 쓰지 못하게 할 도구 (Claude Code). 조율 에이전트는 파일을 고치는 도구를 쓰지 못한다 */
  disallowedTools?: string[];
  /** 작업 폴더 밖에서 읽을 수 있게 할 폴더 (Claude Code). 조율 에이전트가 등록된 저장소를 읽는다 */
  addDirs?: string[];
  /** 설정에서 준 추가 인자. 두레가 정하는 인자와 겹치지 않는 것만 온다 (설정에서 걸러진다) */
  extraArgs?: string[];
}

/** 구조화된 입출력 인자. Orca 의 채팅이 Claude Code 를 띄우는 방식과 같다. */
export const HEADLESS_ARGS = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'] as const;

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'] as const;

// 셸에서 한 낱말로 읽히게 작은따옴표로 감싼다. 경로에 공백이 있다.
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// 두레에 상태를 알리고, 두레가 돌려준 글을 그대로 내보낸다. 실패해도 에이전트를 막지 않는다.
// 토큰은 인자에 넣지 않고(ps 로 보인다) 0600 헤더 파일에서 읽게 한다. -f: 오류 응답의 본문을 내보내지 않는다.
const hookScript = (hookUrl: string, authHeaderFile: string): string => `#!/bin/sh
curl -sf -m 5 -X POST -H @${shq(authHeaderFile)} -H "Content-Type: application/json" --data-binary @- "${hookUrl}/$1" 2>/dev/null
exit 0
`;

// TOML 기본 문자열은 JSON 문자열과 같은 이스케이프를 쓴다.
const toml = (s: string): string => JSON.stringify(s);

/**
 * 에이전트 CLI 를 두레 MCP 서버에 연결된 상태로 띄우는 실행 정보를 만든다.
 * 값의 근거: docs/superpowers/findings/2026-11-11-agent-wiring.md "확정된 실행 방식".
 * Codex 의 권한 인자는 아직 실측하지 못한 값이다.
 */
export function buildAgentLaunch(i: AgentLaunchInput): AgentLaunch {
  const launch = buildBase(i);
  if (i.kind === 'claude' && i.model) launch.args.push('--model', i.model);
  if (i.kind === 'claude' && i.effort) launch.args.push('--effort', i.effort);
  if (i.kind === 'claude' && i.disallowedTools?.length) launch.args.push('--disallowedTools', i.disallowedTools.join(','));
  if (i.kind === 'claude') for (const dir of i.addDirs ?? []) launch.args.push('--add-dir', dir);
  if (i.extraArgs?.length) launch.args.push(...i.extraArgs);
  if (i.headless) {
    if (i.kind !== 'claude') throw new Error('채팅 방식은 Claude Code 만 지원합니다.');
    launch.args.push(...HEADLESS_ARGS);
    if (i.resumeSessionId) launch.args.push('--resume', i.resumeSessionId);
  } else if (i.initialPrompt) {
    // 두 에이전트 모두 프롬프트는 마지막 위치 인자다.
    launch.args.push(i.initialPrompt);
  }
  const commons = (Array.isArray(i.gitCommonDir) ? i.gitCommonDir : [i.gitCommonDir]).filter((c): c is string => Boolean(c));
  if (i.realGit && commons.length) {
    // 에이전트가 실행하는 git 이 이 파일을 먼저 타게 한다 (실험 09). 사용자 셸 탭에는 걸지 않는다.
    const bin = join(i.configDir, 'bin');
    launch.files.push({ path: join(bin, 'git'), content: gitShimScript(i.realGit, commons), mode: 0o700 });
    launch.env.PATH = `${bin}:${i.basePath}`;
  }
  return launch;
}

function buildBase(i: AgentLaunchInput): AgentLaunch {
  if (i.kind === 'claude') {
    const mcpConfig = join(i.configDir, 'mcp.json');
    const settings = join(i.configDir, 'settings.json');
    const authHeader = join(i.configDir, 'auth.hdr');
    const hook = join(i.configDir, 'hook.sh');
    const hooks = Object.fromEntries(HOOK_EVENTS.map((ev) => [
      ev, [{ matcher: '', hooks: [{ type: 'command', command: `${shq(hook)} ${ev}` }] }],
    ]));
    return {
      command: 'claude',
      args: [
        '--mcp-config', mcpConfig,
        '--allowedTools', 'mcp__dure',
        '--settings', settings,
        '--append-system-prompt', i.instructions,
        ...(i.permissionMode === 'bypass' ? ['--dangerously-skip-permissions'] : ['--permission-mode', i.manualEdits ? 'default' : 'acceptEdits']),
      ],
      env: {},
      files: [
        {
          path: mcpConfig,
          content: JSON.stringify({
            mcpServers: { dure: { type: 'http', url: i.mcpUrl, headers: { Authorization: `Bearer ${i.token}` } } },
          }),
        },
        { path: settings, content: JSON.stringify({ hooks }) },
        { path: authHeader, content: `Authorization: Bearer ${i.token}` },
        { path: hook, content: hookScript(i.hookUrl, authHeader), mode: 0o700 },
      ],
    };
  }
  return {
    command: 'codex',
    args: [
      '-c', `mcp_servers.dure.url=${toml(i.mcpUrl)}`,
      '-c', 'mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"',
      '-c', `developer_instructions=${toml(i.instructions)}`,
      ...(i.permissionMode === 'bypass'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']),
    ],
    // 토큰은 인자에 넣지 않는다. 인자는 ps 로 누구나 볼 수 있다.
    env: { DURE_MCP_TOKEN: i.token },
    files: [],
  };
}
