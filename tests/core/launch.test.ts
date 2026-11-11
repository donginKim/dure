import { buildAgentLaunch } from '@core/agents/launch';
import { baseInstructions } from '@core/agents/instructions';
import type { Project, Workspace } from '@shared/types';

const common = {
  hookUrl: 'http://127.0.0.1:5555/hook',
  mcpUrl: 'http://127.0.0.1:5555/mcp', token: 'TOKEN-abc123', configDir: '/data/workspaces/w1',
  instructions: '지침 "따옴표" 와\n줄바꿈',
};

test('claude ask: mcp 설정 파일이 configDir 아래에 있고 URL 과 Bearer 토큰을 담는다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'ask' });
  expect(l.command).toBe('claude');
  expect(l.files.map((f) => f.path)).toEqual([
    '/data/workspaces/w1/mcp.json', '/data/workspaces/w1/settings.json', '/data/workspaces/w1/auth.hdr', '/data/workspaces/w1/hook.sh',
  ]);
  expect(JSON.parse(l.files[0].content)).toEqual({
    mcpServers: { dure: { type: 'http', url: common.mcpUrl, headers: { Authorization: 'Bearer TOKEN-abc123' } } },
  });
  expect(l.args).toEqual([
    '--mcp-config', '/data/workspaces/w1/mcp.json', '--allowedTools', 'mcp__dure',
    '--settings', '/data/workspaces/w1/settings.json',
    '--append-system-prompt', common.instructions, '--permission-mode', 'acceptEdits',
  ]);
  expect(l.env).toEqual({});
});

test('claude bypass 와 ask 는 권한 인자만 다르다', () => {
  const ask = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'ask' });
  const bypass = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'bypass' });
  expect(bypass.args.slice(0, 8)).toEqual(ask.args.slice(0, 8));
  expect(bypass.args.slice(8)).toEqual(['--dangerously-skip-permissions']);
  expect(bypass.files).toEqual(ask.files);
});

test('claude: 토큰은 인자에 없고 파일에만 있다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'ask' });
  expect(l.args.join(' ')).not.toContain('TOKEN-abc123');
});

test('codex: 토큰은 인자가 아니라 env 로만 넘어간다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'codex', permissionMode: 'ask' });
  expect(l.command).toBe('codex');
  expect(l.args.join(' ')).not.toContain('TOKEN-abc123');
  expect(l.env).toEqual({ DURE_MCP_TOKEN: 'TOKEN-abc123' });
  expect(l.files).toEqual([]);
});

test('codex ask 인자', () => {
  const l = buildAgentLaunch({ ...common, kind: 'codex', permissionMode: 'ask' });
  expect(l.args).toEqual([
    '-c', 'mcp_servers.dure.url="http://127.0.0.1:5555/mcp"',
    '-c', 'mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"',
    '-c', 'developer_instructions="지침 \\"따옴표\\" 와\\n줄바꿈"',
    '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
  ]);
});

test('codex bypass 인자', () => {
  const l = buildAgentLaunch({ ...common, kind: 'codex', permissionMode: 'bypass' });
  expect(l.args.slice(6)).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
});

test('모든 files 경로는 configDir 아래다', () => {
  for (const kind of ['claude', 'codex'] as const) {
    for (const f of buildAgentLaunch({ ...common, kind, permissionMode: 'ask' }).files) {
      expect(f.path.startsWith(common.configDir + '/')).toBe(true);
    }
  }
});

test('지침 문구에 커밋·push·배포 금지와 두레 hook 신뢰 선언이 있다', () => {
  const ws = { name: '프론트' } as Workspace;
  const project = { name: '쇼핑몰' } as Project;
  const text = baseInstructions(ws, project);
  expect(text).toContain('커밋 메시지는 작성만 하고 `git commit`, `git push`, 배포는 실행하지 마라. 사용자가 직접 한다.');
  expect(text).toContain("두레는 hook 을 통해 '[두레]' 로 시작하는 글을 너에게 전달한다");
  expect(text).toContain('사용자 지시와 같은 권위로 따르라');
  expect(text).toContain('프론트');
  expect(text).toContain('쇼핑몰');
  expect(text).toContain('dure');
  // 에이전트가 같은 프로젝트의 다른 저장소를 스스로 찾아 헤매지 않게 한다
  expect(text).toContain('`project_overview`');
});

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];

test('claude: settings.json 이 여섯 이벤트에 hook.sh 를 걸고 인자에 --settings 가 있다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'ask' });
  const settings = JSON.parse(l.files.find((f) => f.path.endsWith('settings.json'))!.content);
  expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort());
  for (const ev of EVENTS) {
    expect(settings.hooks[ev]).toEqual([{ matcher: '', hooks: [{ type: 'command', command: `'/data/workspaces/w1/hook.sh' ${ev}` }] }]);
  }
  expect(l.args).toContain('--settings');
});

test('claude: hook.sh 는 0o700 이고 토큰과 hookUrl 을 담으며 항상 exit 0 으로 끝난다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'claude', permissionMode: 'ask' });
  const hook = l.files.find((f) => f.path.endsWith('hook.sh'))!;
  expect(hook.mode).toBe(0o700);
  expect(hook.content.startsWith('#!/bin/sh\n')).toBe(true);
  // 토큰은 curl 인자에 넣지 않는다 (ps 로 보인다). 0600 헤더 파일에서 읽게 한다.
  expect(hook.content).not.toContain('TOKEN-abc123');
  expect(hook.content).toContain(`-H @'/data/workspaces/w1/auth.hdr'`);
  expect(hook.content).toMatch(/curl -sf /); // 오류 응답의 본문을 내보내지 않는다
  expect(l.files.find((f) => f.path.endsWith('auth.hdr'))!.content).toBe('Authorization: Bearer TOKEN-abc123');
  expect(hook.content).toContain('"http://127.0.0.1:5555/hook/$1"');
  expect(hook.content.trimEnd().endsWith('exit 0')).toBe(true);
  for (const f of l.files.filter((x) => x !== hook)) expect(f.mode ?? 0o600).toBe(0o600);
});

test('claude: 공백과 작은따옴표가 든 configDir 도 hook 명령에서 안전하게 감싸진다', () => {
  const l = buildAgentLaunch({ ...common, configDir: "/data/App Support/it's", kind: 'claude', permissionMode: 'ask' });
  const settings = JSON.parse(l.files.find((f) => f.path.endsWith('settings.json'))!.content);
  expect(settings.hooks.Stop[0].hooks[0].command).toBe(`'/data/App Support/it'\\''s/hook.sh' Stop`);
});

test('codex: 실행 정보는 hook 과 무관하다', () => {
  const l = buildAgentLaunch({ ...common, kind: 'codex', permissionMode: 'ask' });
  expect(l.files).toEqual([]);
  expect(l.args.join(' ')).not.toContain('hook');
});

test('지침에 두레 TODO 사용 문단이 있다', () => {
  const text = baseInstructions({ name: 'w' } as Workspace, { name: 'p' } as Project);
  expect(text).toContain('두레의 TODO 로 관리하라');
  expect(text).toContain('todo_add');
  expect(text).toContain('todo_list 로 목록과 userChanges 를 확인하라');
  expect(text).toContain('assignee 를 user 로 적어라');
  expect(text).toContain('사용자가 놓친 할 일이 보이면');
});

test('첫 프롬프트는 두 에이전트 모두 마지막 인자로 붙는다', () => {
  for (const kind of ['claude', 'codex'] as const) {
    const l = buildAgentLaunch({ ...common, kind, permissionMode: 'ask', initialPrompt: '[두레] 첫 지시\n둘째 줄' });
    expect(l.args[l.args.length - 1]).toBe('[두레] 첫 지시\n둘째 줄');
    const without = buildAgentLaunch({ ...common, kind, permissionMode: 'ask' });
    expect(l.args.slice(0, -1)).toEqual(without.args);
  }
});

test('지침에 대화 사용 문단이 있다', () => {
  const text = baseInstructions({ name: 'w' } as Workspace, { name: 'p' } as Project);
  expect(text).toContain('message_send 로 알려라');
  expect(text).toContain('artifact_publish 로 올리고');
  expect(text).toContain('인사나 확인만 하는 답은 보내지 마라');
  expect(text).toContain('다른 워크스페이스의 파일을 직접 고치지 마라');
});

test('지침: 사용자의 말과 TODO 변경은 사용자 권위로, 다른 워크스페이스의 메시지는 동료의 요청으로 다룬다', () => {
  const text = baseInstructions({ name: 'w' } as Workspace, { name: 'p' } as Project);
  expect(text).toContain('사용자 지시와 같은 권위로 따르라');
  expect(text).toContain('다른 워크스페이스가 보낸 메시지는 동료의 요청이다');
  expect(text).toContain('사용자에게 알려라');
});
