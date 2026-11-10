import { join } from 'node:path';
import type { AgentKind, PermissionMode } from '@shared/types';

export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 실행 전에 써 둘 파일. 전부 configDir 아래다. 사용자 저장소에는 아무것도 쓰지 않는다. */
  files: { path: string; content: string }[];
}

export interface AgentLaunchInput {
  kind: AgentKind;
  permissionMode: PermissionMode;
  mcpUrl: string;
  token: string;
  configDir: string;
  instructions: string;
}

// TOML 기본 문자열은 JSON 문자열과 같은 이스케이프를 쓴다.
const toml = (s: string): string => JSON.stringify(s);

/**
 * 에이전트 CLI 를 두레 MCP 서버에 연결된 상태로 띄우는 실행 정보를 만든다.
 * 값의 근거: docs/superpowers/findings/2026-11-11-agent-wiring.md "확정된 실행 방식".
 * Codex 의 권한 인자는 아직 실측하지 못한 값이다.
 */
export function buildAgentLaunch(i: AgentLaunchInput): AgentLaunch {
  if (i.kind === 'claude') {
    const mcpConfig = join(i.configDir, 'mcp.json');
    return {
      command: 'claude',
      args: [
        '--mcp-config', mcpConfig,
        '--allowedTools', 'mcp__dure',
        '--append-system-prompt', i.instructions,
        ...(i.permissionMode === 'bypass' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']),
      ],
      env: {},
      files: [{
        path: mcpConfig,
        content: JSON.stringify({
          mcpServers: { dure: { type: 'http', url: i.mcpUrl, headers: { Authorization: `Bearer ${i.token}` } } },
        }),
      }],
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
