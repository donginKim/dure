import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { makeRepo, tempDir } from '../helpers/repo';

// 채팅 방식(터미널 화면 없이 도는 에이전트)을 가짜 Claude Code 로 시험한다.
// 가짜는 실제와 같은 모양의 JSON 줄을 내고(실험 17, 18), 두레가 써 준 hook 스크립트를 실제로 실행한다.
const FAKE = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
const dir = path.dirname(argv[argv.indexOf('--settings') + 1]);
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(argv) + '\\n');
const resume = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
if (resume === 'gone') { process.stderr.write('No conversation found with session ID: gone\\n'); process.exit(1); }
if (process.env.FAKE_CRASH) { process.stderr.write('첫째 줄\\n로그인이 필요합니다\\n'); process.exit(2); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const hook = (ev, body) => { try { return execFileSync(path.join(dir, 'hook.sh'), [ev], { input: JSON.stringify(body ?? {}), encoding: 'utf8' }); } catch { return ''; } };
const session = resume ?? 's-new';
out({ type: 'system', subtype: 'init', session_id: session });
hook('SessionStart', { source: resume ? 'resume' : 'startup' });
let waiting = null; let busy = null; let outstanding = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    if (m.request.subtype === 'initialize') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [{ name: 'compact', description: '대화를 줄인다', argumentHint: '' }, { name: 'model', description: '모델을 바꾼다', argumentHint: '<name>' }, { bad: 1 }], models: [{ value: 'default', displayName: 'Default (recommended)', description: '기본', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }, { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '복잡한 일', supportsEffort: false, supportedEffortLevels: ['low'] }, { nope: true }] } } });
    if (m.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
      if (busy) { clearTimeout(busy); busy = null; out({ type: 'result', subtype: 'error_during_execution' }); }
      return;
    }
    return;
  }
  if (m.type === 'control_response') {
    const r = m.response.response; const w = waiting; waiting = null;
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer:' + JSON.stringify(r) }] } });
    fs.appendFileSync(path.join(dir, 'answers.log'), JSON.stringify({ requestId: m.response.request_id, subtype: m.response.subtype, response: r, error: m.response.error }) + '\\n');
    if (m.response.subtype === 'error') return;
    fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify({ requestId: m.response.request_id, expected: w, response: r }));
    if (outstanding > 1) { outstanding--; return; } // 아직 답을 기다리는 요청이 있다
    outstanding = 0;
    hook('Stop'); out({ type: 'result', subtype: 'success' });
    return;
  }
  const text = m.message.content;
  fs.appendFileSync(path.join(dir, 'said.log'), JSON.stringify(text) + '\\n');
  hook('UserPromptSubmit', { prompt: text });
  if (text === 'perm') { waiting = 'r-perm'; return out({ type: 'control_request', request_id: 'r-perm', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'curl https://example.com' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl *' }], behavior: 'allow', destination: 'localSettings' }] } }); }
  if (text === 'perm-plain') { waiting = 'r-plain'; return out({ type: 'control_request', request_id: 'r-plain', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/a/b.txt', content: 'x' } } }); }
  if (text === 'ask') { waiting = 'r-ask'; return out({ type: 'control_request', request_id: 'r-ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: '어떤 색?', header: '색', multiSelect: false, options: [{ label: '빨강', description: '따뜻함' }, { label: '파랑', description: '차가움' }] }] } } }); }
  if (text === 'two') {
    outstanding = 2;
    out({ type: 'control_request', request_id: 'r-a', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    out({ type: 'control_request', request_id: 'r-b', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    return;
  }
  if (text === 'cancel') {
    out({ type: 'control_request', request_id: 'r-c', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    setTimeout(() => out({ type: 'control_cancel_request', request_id: 'r-c' }), 400);
    return;
  }
  if (text === 'hook-while-waiting') {
    waiting = 'r-h';
    out({ type: 'control_request', request_id: 'r-h', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    setTimeout(() => { hook('PreToolUse', { tool_name: 'Read' }); hook('PostToolUse', { tool_name: 'Read' }); hook('Notification', { notification_type: 'permission_prompt' }); fs.writeFileSync(path.join(dir, 'hooks-done'), '1'); }, 300);
    return;
  }
  if (text === 'weird') { out({ type: 'control_request', request_id: 'r-w', request: { subtype: 'something_new' } }); hook('Stop'); out({ type: 'result', subtype: 'success' }); return; }
  if (text === 'ask2') { waiting = 'r-ask2'; return out({ type: 'control_request', request_id: 'r-ask2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: '색?', header: '', multiSelect: false, options: [{ label: '빨강' }] }, { question: '크기?', header: '', multiSelect: true, options: [{ label: '크게' }, { label: '작게' }] }] } } }); }
  if (text === 'long') { busy = setTimeout(() => { hook('Stop'); out({ type: 'result', subtype: 'success' }); }, 20000); return; }
  if (text === 'stream') {
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '안녕' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '하세요' } } });
    out({ type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '하위 에이전트의 글' } } });
    return; // 덩어리가 끝나지 않은 채로 둔다
  }
  if (text === 'fail') { out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate' }] } }); out({ type: 'result', subtype: 'success', is_error: true }); return; } // Stop hook 없이 끝난다
  if (text === 'finish') { out({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕하세요' }] } }); hook('Stop'); out({ type: 'result', subtype: 'success' }); return; }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + text }] } });
  hook('Stop'); out({ type: 'result', subtype: 'success' });
});
`;

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let fakeBin: string;
let projectId: string;
let repoId: string;
let extraEnv: Record<string, string> = {};

const until = (cond: () => boolean, ms = 6000): Promise<void> => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = (): void => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : void setTimeout(tick, 20));
  tick();
});
const status = (id: string): string | undefined => core.workspaces.get(id)?.status;
const cfg = (id: string, file: string): string => join(dataDir, 'workspaces', id, file);
const said = (id: string): string[] => (existsSync(cfg(id, 'said.log')) ? readFileSync(cfg(id, 'said.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string) : []);
const answer = (id: string): { requestId: string; response: Record<string, unknown> } => JSON.parse(readFileSync(cfg(id, 'answer.json'), 'utf8'));
const answers = (id: string): { requestId: string; subtype: string; response: Record<string, unknown>; error?: string }[] => (existsSync(cfg(id, 'answers.log')) ? readFileSync(cfg(id, 'answers.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const reqId = (id: string): string => core.chatView(id).pendingPermission?.requestId ?? core.chatView(id).question?.requestId ?? '';
const argvLog = (id: string): string[][] => (existsSync(cfg(id, 'argv.log')) ? readFileSync(cfg(id, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []);

async function boot(): Promise<void> {
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir(), ...extraEnv }, claudeDir: tempDir() });
}

beforeEach(async () => {
  extraEnv = {};
  dataDir = join(tempDir(), 'dure data');
  fakeBin = join(tempDir(), 'fake bin');
  mkdirSync(fakeBin);
  const js = join(fakeBin, 'fake-claude.js');
  writeFileSync(js, FAKE);
  // 테스트는 Electron 의 node 로 돈다. 같은 실행 파일을 node 로 쓴다.
  writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${js}' "$@"\n`);
  chmodSync(join(fakeBin, 'claude'), 0o755);
  await boot();
  projectId = core.projects.create('쇼핑몰').id;
  repoId = (await core.addRepo(projectId, makeRepo('front'))).id;
});
afterEach(async () => { await core.dispose(); });

async function runHookFor(id: string, event: string, body: object): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = execFile(cfg(id, 'hook.sh'), [event], { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end(JSON.stringify(body));
  });
}

const create = (name: string, over = {}) => core.service.create({ projectId, repoId, name, baseBranch: 'main', agentKind: 'claude', ...over });
async function started(name: string) {
  const ws = await create(name);
  expect(await core.service.startAgent(ws.id, SIZE)).toBeNull();
  await until(() => status(ws.id) === 'idle');
  return ws;
}

test('새 Claude Code 워크스페이스는 채팅 방식이고, Codex 는 터미널 방식이다', async () => {
  expect((await create('a')).engine).toBe('chat');
  expect((await create('b', { engine: 'terminal' })).engine).toBe('terminal');
  expect((await create('c', { agentKind: 'codex', engine: 'chat' })).engine).toBe('terminal');
});

test('채팅 방식으로 띄우면 터미널이 없고, 구조화된 입출력 인자로 뜨고, 대화 id 를 기억한다', async () => {
  const ws = await started('boot');
  expect(core.pty.list(ws.id)).toEqual([]);
  expect(core.service.isAgentRunning(ws.id)).toBe(true);
  const argv = argvLog(ws.id)[0]!;
  expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--permission-mode', 'acceptEdits', '--mcp-config', '--settings']));
  expect(argv).not.toContain('--resume');
  expect(core.workspaces.getSessionId(ws.id)).toBe('s-new');
  // 두 번 불러도 하나만 뜬다
  expect(await core.service.startAgent(ws.id, SIZE)).toBeNull();
  expect(argvLog(ws.id).length).toBe(1);
});

test('채팅으로 보낸 글은 메시지로 가고, 작업 중 → 쉬는 중으로 돌아온다', async () => {
  const ws = await started('send');
  expect(core.chatView(ws.id)).toMatchObject({ engine: 'chat', canSend: true });
  await core.service.sendUserInput(ws.id, '로그인 화면 만들어줘');
  await until(() => said(ws.id).length === 1);
  expect(said(ws.id)).toEqual(['로그인 화면 만들어줘']);
  await until(() => status(ws.id) === 'idle' && core.service.isConfirmedIdle(ws.id));
});

test('쓰는 중인 글이 조각마다 쌓여 보이고, 덩어리가 끝나면 사라진다. 하위 에이전트의 글은 섞이지 않는다', async () => {
  const ws = await started('stream');
  await core.service.sendUserInput(ws.id, 'stream');
  await until(() => core.chatView(ws.id).streaming === '안녕하세요');
  expect(status(ws.id)).toBe('working');
  await core.service.sendUserInput(ws.id, 'finish'); // 작업 중에도 보낼 수 있다
  await until(() => core.chatView(ws.id).streaming === null && status(ws.id) === 'idle');
});

test('승인 요청이 이벤트로 오면 사용자 기다림이 되고, 허용하면 입력을 그대로 돌려준다', async () => {
  const ws = await started('perm');
  await core.service.sendUserInput(ws.id, 'perm');
  await until(() => status(ws.id) === 'waiting_user');
  expect(core.chatView(ws.id).pendingPermission).toEqual({
    tool: 'Bash', summary: 'curl https://example.com', input: 'curl https://example.com', canAnswer: true,
    canAlways: true, alwaysRule: 'Bash: curl *', requestId: 'r-perm', more: 0,
  });
  core.service.answerPermission(ws.id, 'allow', 'r-perm');
  expect(status(ws.id)).toBe('working');
  expect(core.chatView(ws.id).pendingPermission).toBeNull();
  // 같은 요청에 두 번 답하지 못한다
  expect(() => core.service.answerPermission(ws.id, 'allow', 'r-perm')).toThrow('승인을 기다리는 중이 아닙니다.');
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  expect(answer(ws.id)).toEqual({ requestId: 'r-perm', expected: 'r-perm', response: { behavior: 'allow', updatedInput: { command: 'curl https://example.com' } } });
  await until(() => status(ws.id) === 'idle');
});

test('"앞으로 묻지 않기" 는 에이전트가 제안한 규칙을 함께 돌려준다. 제안이 없으면 쓸 수 없다', async () => {
  const ws = await started('always');
  await core.service.sendUserInput(ws.id, 'perm');
  await until(() => status(ws.id) === 'waiting_user');
  core.service.answerPermission(ws.id, 'always', reqId(ws.id));
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  // 에이전트는 작업 폴더의 설정 파일(localSettings)에 남기자고 제안했지만, 두레는 이번 대화에만 적용되게 고쳐 돌려준다.
  expect(answer(ws.id).response).toEqual({ behavior: 'allow', updatedInput: { command: 'curl https://example.com' }, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl *' }], behavior: 'allow', destination: 'session' }] });
  await until(() => status(ws.id) === 'idle');
  await core.service.sendUserInput(ws.id, 'perm-plain');
  await until(() => status(ws.id) === 'waiting_user');
  expect(core.chatView(ws.id).pendingPermission).toMatchObject({ tool: 'Write', summary: 'b.txt 씀', canAlways: false });
  expect(() => core.service.answerPermission(ws.id, 'always', reqId(ws.id))).toThrow('앞으로 묻지 않기');
  expect(status(ws.id)).toBe('waiting_user'); // 답하지 못했으니 그대로 기다린다
});

test('거부하면 deny 와 이유를 돌려준다', async () => {
  const ws = await started('deny');
  await core.service.sendUserInput(ws.id, 'perm');
  await until(() => status(ws.id) === 'waiting_user');
  core.service.answerPermission(ws.id, 'deny', reqId(ws.id));
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  expect(answer(ws.id).response).toEqual({ behavior: 'deny', message: '사용자가 거부했습니다.' });
});

test('여러 선택지 질문: 질문이 화면용으로 오고, 고른 답이 answers 로 돌아간다', async () => {
  const ws = await started('ask');
  await core.service.sendUserInput(ws.id, 'ask');
  await until(() => status(ws.id) === 'waiting_user');
  const view = core.chatView(ws.id);
  expect(view.pendingPermission).toBeNull();
  expect(view.question).toEqual({ requestId: 'r-ask', questions: [{ question: '어떤 색?', header: '색', multiSelect: false, options: [{ label: '빨강', description: '따뜻함' }, { label: '파랑', description: '차가움' }] }] });
  // 질문에는 승인으로 답할 수 없다
  expect(() => core.service.answerPermission(ws.id, 'allow', 'r-ask')).toThrow('승인을 기다리는 중이 아닙니다.');
  expect(() => core.service.answerQuestion(ws.id, 'r-ask', {})).toThrow('모든 질문에 답하세요.');
  // 묻지 않은 것에 대한 답은 버린다
  expect(() => core.service.answerQuestion(ws.id, 'r-ask', { '묻지 않은 질문': '답' })).toThrow('모든 질문에 답하세요.');
  core.service.answerQuestion(ws.id, 'r-ask', { '어떤 색?': ' 파랑 ', '묻지 않은 질문': '끼워 넣기' });
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  expect(answer(ws.id).response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { '어떤 색?': '파랑' }, questions: expect.any(Array) } });
  expect((answer(ws.id).response.updatedInput as { answers: object }).answers).toEqual({ '어떤 색?': '파랑' });
  expect(core.chatView(ws.id).question).toBeNull();
});

test('질문을 답하지 않고 넘기면 deny 가 간다', async () => {
  const ws = await started('ask-skip');
  await core.service.sendUserInput(ws.id, 'ask');
  await until(() => status(ws.id) === 'waiting_user');
  core.service.dismissQuestion(ws.id, 'r-ask');
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  expect(answer(ws.id).response).toMatchObject({ behavior: 'deny' });
});

test('멈춤: 에이전트에게 멈춤 요청이 가고 쉬는 중이 된다. 프로세스는 살아 있다', async () => {
  const ws = await started('interrupt');
  await core.service.sendUserInput(ws.id, 'long');
  await until(() => status(ws.id) === 'working');
  core.service.interrupt(ws.id);
  expect(status(ws.id)).toBe('idle');
  await new Promise((r) => setTimeout(r, 300));
  expect(core.service.isAgentRunning(ws.id)).toBe(true);
  await core.service.sendUserInput(ws.id, '이어서');
  await until(() => said(ws.id).includes('이어서'));
});

test('쉬는 중인 채팅 방식 에이전트에게 메시지가 오면 터미널이 아니라 메시지로 깨운다', async () => {
  const front = await started('front');
  const back = await started('back');
  await core.service.sendUserInput(back.id, '준비');
  await until(() => core.service.isConfirmedIdle(back.id));
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '로그인 API 형식 알려줘' });
  await until(() => said(back.id).some((t) => t.startsWith('[두레]') && t.includes('> 로그인 API 형식 알려줘')));
  expect(core.pty.list(back.id)).toEqual([]);
  await until(() => core.messages.undelivered(back.id).length === 0);
});

test('꺼진 채팅 방식 에이전트에게 메시지가 오면 그 메시지를 첫 말로 띄운다', async () => {
  const front = await started('front2');
  const back = await create('back2');
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '깨어나라' });
  await until(() => said(back.id).some((t) => t.includes('> 깨어나라')), 8000);
  expect(argvLog(back.id)[0]!.some((a) => a.includes('깨어나라'))).toBe(false); // 인자가 아니라 표준 입력으로 보낸다
});

test('끄면 꺼짐이 되고, 다시 시작하면 지난 대화를 이어 띄운다', async () => {
  const ws = await started('resume');
  core.service.stopAgent(ws.id);
  await until(() => status(ws.id) === 'stopped');
  expect(core.service.isAgentRunning(ws.id)).toBe(false);
  expect(core.chatView(ws.id).canSend).toBe(false);
  await core.service.startAgent(ws.id, SIZE);
  await until(() => status(ws.id) === 'idle');
  const second = argvLog(ws.id)[1]!;
  expect(second[second.indexOf('--resume') + 1]).toBe('s-new');
});

test('이어갈 대화가 사라졌으면 새 대화로 한 번 다시 띄운다', async () => {
  const ws = await create('resume-gone');
  core.workspaces.setSessionId(ws.id, 'gone');
  await core.service.startAgent(ws.id, SIZE);
  await until(() => argvLog(ws.id).length === 2 && status(ws.id) === 'idle', 8000);
  expect(argvLog(ws.id)[1]).not.toContain('--resume');
  expect(core.workspaces.getSessionId(ws.id)).toBe('s-new');
});

test('에이전트가 오류로 끝나면 꺼짐이 되고 이유의 끝부분이 화면에 간다. 다시 시작하면 지워진다', async () => {
  await core.dispose();
  extraEnv = { FAKE_CRASH: '1' };
  await boot();
  projectId = core.projects.create('p2').id;
  repoId = (await core.addRepo(projectId, makeRepo('crash'))).id;
  const ws = await create('crash');
  await core.service.startAgent(ws.id, SIZE);
  await until(() => status(ws.id) === 'stopped' && core.chatView(ws.id).lastError !== null);
  expect(core.chatView(ws.id).lastError).toContain('로그인이 필요합니다');
  await expect(core.service.sendUserInput(ws.id, '안녕')).rejects.toThrow();
});

test('슬래시 명령 목록을 에이전트에게서 받아 둔다 (모양이 다른 항목은 버린다)', async () => {
  const ws = await started('commands');
  await until(() => core.slashCommands(ws.id).length === 2);
  expect(core.slashCommands(ws.id)).toEqual([{ name: 'compact', description: '대화를 줄인다', argumentHint: '' }, { name: 'model', description: '모델을 바꾼다', argumentHint: '<name>' }]);
  expect(core.slashCommands('없는-id')).toEqual([]);
});

test('방식은 에이전트가 꺼져 있을 때만 바꿀 수 있고, Codex 는 채팅 방식으로 바꿀 수 없다', async () => {
  const ws = await started('engine');
  expect(() => core.service.setEngine(ws.id, 'terminal')).toThrow('에이전트를 끈 뒤에 바꿀 수 있습니다.');
  core.service.stopAgent(ws.id);
  await until(() => status(ws.id) === 'stopped');
  core.service.setEngine(ws.id, 'terminal');
  expect(core.workspaces.get(ws.id)?.engine).toBe('terminal');
  const cx = await create('cx', { agentKind: 'codex' });
  expect(() => core.service.setEngine(cx.id, 'chat')).toThrow('채팅 방식은 Claude Code 만 지원합니다.');
});

test('워크스페이스를 지우면 에이전트가 꺼진다. 코어를 닫아도 남는 프로세스가 없다', async () => {
  const ws = await started('remove');
  const other = await started('other');
  await core.service.remove(ws.id, { deleteWorktree: true });
  expect(core.service.isAgentRunning(ws.id)).toBe(false);
  expect(core.service.isAgentRunning(other.id)).toBe(true);
  await core.dispose();
  expect(core.engine.has(other.id)).toBe(false);
});

test('Stop hook 없이 차례가 끝나도(로그인 만료 같은 오류) 작업 중에 머물지 않는다', async () => {
  const ws = await started('fail');
  await core.service.sendUserInput(ws.id, 'fail');
  await until(() => said(ws.id).length === 1);
  await until(() => status(ws.id) === 'idle');
  expect(core.chatView(ws.id).canSend).toBe(true);
});

test('대화 기록 폴더는 에이전트가 물려받는 CLAUDE_CONFIG_DIR 를 따른다', async () => {
  await core.dispose();
  const profile = join(tempDir(), 'profile');
  mkdirSync(join(profile, 'projects', 'p'), { recursive: true });
  const file = join(profile, 'projects', 'p', 's.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: '프로필 폴더의 기록' } })}\n`);
  core = await createCore({ dataDir: join(tempDir(), 'd2'), worktreeRoot: join(tempDir(), 'wt2'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir(), CLAUDE_CONFIG_DIR: profile } });
  projectId = core.projects.create('p3').id;
  repoId = (await core.addRepo(projectId, makeRepo('profile'))).id;
  const ws = await create('profile');
  core.chat.noteHook(ws.id, 'Stop', { transcript_path: file });
  expect(core.chatView(ws.id)).toMatchObject({ available: true, items: [expect.objectContaining({ text: '프로필 폴더의 기록' })] });
});

// ---- 리뷰에서 나온 경우들 ----

test('승인 요청이 동시에 둘 오면 줄을 세워 하나씩 보이고, 답은 화면에 보인 그 요청에만 간다', async () => {
  const ws = await started('two');
  await core.service.sendUserInput(ws.id, 'two');
  await until(() => core.chatView(ws.id).pendingPermission?.more === 1);
  expect(core.chatView(ws.id).pendingPermission).toMatchObject({ requestId: 'r-a', summary: 'rm -rf build', more: 1 });
  // 화면에 보이지 않는 요청의 id 로는 답할 수 없다
  expect(() => core.service.answerPermission(ws.id, 'allow', 'r-b')).toThrow('화면의 요청이 바뀌었습니다.');
  expect(() => core.service.answerPermission(ws.id, 'allow', '')).toThrow('화면의 요청이 바뀌었습니다.');
  core.service.answerPermission(ws.id, 'deny', 'r-a');
  // 아직 하나가 기다린다: 사용자 기다림 그대로이고 다음 요청이 보인다
  expect(status(ws.id)).toBe('waiting_user');
  expect(core.chatView(ws.id).pendingPermission).toMatchObject({ requestId: 'r-b', summary: 'ls', more: 0 });
  // 방금 누른 버튼을 한 번 더 눌러도(옛 id) 새 요청에 적용되지 않는다
  expect(() => core.service.answerPermission(ws.id, 'deny', 'r-a')).toThrow('화면의 요청이 바뀌었습니다.');
  core.service.answerPermission(ws.id, 'allow', 'r-b');
  await until(() => answers(ws.id).length === 2);
  expect(answers(ws.id).map((a) => [a.requestId, a.response.behavior])).toEqual([['r-a', 'deny'], ['r-b', 'allow']]);
  await until(() => status(ws.id) === 'idle');
});

test('에이전트가 물음을 거둬들이면 카드가 사라지고 사용자 기다림에서 풀린다', async () => {
  const ws = await started('cancel');
  await core.service.sendUserInput(ws.id, 'cancel');
  await until(() => status(ws.id) === 'waiting_user');
  await until(() => core.chatView(ws.id).pendingPermission === null);
  expect(status(ws.id)).toBe('working');
  expect(() => core.service.answerPermission(ws.id, 'allow', 'r-c')).toThrow('승인을 기다리는 중이 아닙니다.');
});

test('승인을 기다리는 동안 다른 hook 이 와도 사용자 기다림이 유지되고 카드가 남는다. 답한 뒤에 늦은 알림이 와도 다시 기다림이 되지 않는다', async () => {
  const ws = await started('hook-while');
  await core.service.sendUserInput(ws.id, 'hook-while-waiting');
  await until(() => existsSync(cfg(ws.id, 'hooks-done')));
  expect(status(ws.id)).toBe('waiting_user');
  expect(core.chatView(ws.id).pendingPermission).toMatchObject({ requestId: 'r-h' });
  core.service.answerPermission(ws.id, 'allow', 'r-h');
  await until(() => status(ws.id) === 'idle');
  // 답한 뒤의 승인 알림 hook (채팅 방식에서는 엔진의 대기가 근거다)
  core.service.noteWaiting(ws.id, false);
  await runHookFor(ws.id, 'Notification', { notification_type: 'permission_prompt' });
  expect(status(ws.id)).not.toBe('waiting_user');
});

test('모르는 종류의 물음에는 오류로 답해 에이전트가 기다리지 않게 한다', async () => {
  const ws = await started('weird');
  await core.service.sendUserInput(ws.id, 'weird');
  await until(() => answers(ws.id).length === 1);
  expect(answers(ws.id)[0]).toMatchObject({ requestId: 'r-w', subtype: 'error' });
  expect(core.chatView(ws.id).pendingPermission).toBeNull();
});

test('질문이 여럿이면 전부 답해야 한다', async () => {
  const ws = await started('ask2');
  await core.service.sendUserInput(ws.id, 'ask2');
  await until(() => core.chatView(ws.id).question !== null);
  expect(() => core.service.answerQuestion(ws.id, 'r-ask2', { '색?': '빨강' })).toThrow('모든 질문에 답하세요.');
  expect(core.chatView(ws.id).question).not.toBeNull(); // 답하지 못했으니 그대로 묻고 있다
  core.service.answerQuestion(ws.id, 'r-ask2', { '색?': '빨강', '크기?': '크게, 작게' });
  await until(() => existsSync(cfg(ws.id, 'answer.json')));
  expect((answer(ws.id).response.updatedInput as { answers: object }).answers).toEqual({ '색?': '빨강', '크기?': '크게, 작게' });
});

test('이어 띄운 직후에 끄면 그대로 꺼지고, 이어갈 대화 id 도 남는다 (다시 뜨지 않는다)', async () => {
  const ws = await started('stop-soon');
  core.service.stopAgent(ws.id);
  await until(() => status(ws.id) === 'stopped');
  await core.service.startAgent(ws.id, SIZE); // --resume s-new
  await until(() => status(ws.id) === 'idle');
  core.service.stopAgent(ws.id); // 띄운 지 10초 안
  await until(() => status(ws.id) === 'stopped');
  await new Promise((r) => setTimeout(r, 500));
  expect(status(ws.id)).toBe('stopped');
  expect(core.service.isAgentRunning(ws.id)).toBe(false);
  expect(core.workspaces.getSessionId(ws.id)).toBe('s-new');
  expect(argvLog(ws.id).length).toBe(2);
});

test('끈 직후에 다시 시작하면 앞의 것이 끝난 뒤에 새로 뜬다', async () => {
  const ws = await started('restart-fast');
  core.service.stopAgent(ws.id);
  await core.service.startAgent(ws.id, SIZE);
  await until(() => argvLog(ws.id).length === 2 && status(ws.id) === 'idle');
  expect(core.service.isAgentRunning(ws.id)).toBe(true);
});

test('막 띄운 채팅 방식 에이전트에게도 기다리던 메시지가 전달된다 (사용자가 먼저 말을 걸지 않아도)', async () => {
  const front = await started('f3');
  const back = await started('b3'); // 띄우기만 하고 아무 말도 하지 않았다
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '막 뜬 너에게' });
  await until(() => said(back.id).some((t) => t.includes('> 막 뜬 너에게')));
});

test('멈춘 뒤에 온 메시지도 전달된다', async () => {
  const front = await started('f4');
  const back = await started('b4');
  await core.service.sendUserInput(back.id, 'long');
  await until(() => status(back.id) === 'working');
  core.service.interrupt(back.id);
  await until(() => status(back.id) === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '멈춘 뒤의 메시지' });
  await until(() => said(back.id).some((t) => t.includes('> 멈춘 뒤의 메시지')));
});

test('코어를 닫은 뒤에는 에이전트를 띄우지 않는다', async () => {
  const ws = await create('after-close');
  await core.dispose();
  await expect(core.service.startAgent(ws.id, SIZE)).rejects.toThrow();
  expect(core.engine.has(ws.id)).toBe(false);
});

// ---- 설정이 실제 동작에 반영되는가 ----

test('설정의 모델과 추가 인자가 에이전트의 인자로 들어간다 (다음에 시작할 때부터)', async () => {
  core.settings.update({ claudeModel: 'opus', claudeEffort: 'high', claudeArgs: '--add-dir "/a b"' });
  const ws = await started('args');
  const argv = argvLog(ws.id)[0]!;
  expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
  expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
  expect(argv).toEqual(expect.arrayContaining(['--add-dir', '/a b']));
  // 두레가 정하는 인자는 그대로다
  expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--output-format', 'stream-json']));
});

test('설정의 실행 파일 경로를 쓴다. 쓸 수 없는 경로면 이유를 알려 주고 띄우지 않는다', async () => {
  const other = join(fakeBin, 'my-claude');
  writeFileSync(other, readFileSync(join(fakeBin, 'claude')));
  chmodSync(other, 0o755);
  core.settings.update({ claudePath: other });
  const ws = await started('custom-path');
  expect(core.service.isAgentRunning(ws.id)).toBe(true);
  core.settings.update({ claudePath: '/nonexistent/claude' });
  const ws2 = await create('bad-path');
  await expect(core.service.startAgent(ws2.id, SIZE)).rejects.toThrow('설정에 적힌 실행 파일을 쓸 수 없습니다: /nonexistent/claude');
  expect(status(ws2.id)).toBe('stopped');
});

test('새 워크스페이스의 기본 방식·권한 모드·작업 폴더 위치는 설정을 따른다', async () => {
  const root = join(tempDir(), '내 작업 폴더');
  core.settings.update({ defaultEngine: 'terminal', defaultPermissionMode: 'bypass', worktreeRoot: root });
  const ws = await create('defaults');
  expect(ws).toMatchObject({ engine: 'terminal', permissionMode: 'bypass' });
  expect(ws.worktreePath.startsWith(root)).toBe(true);
  // 만들 때 직접 고른 값이 먼저다
  expect(await create('explicit', { engine: 'chat', permissionMode: 'ask' })).toMatchObject({ engine: 'chat', permissionMode: 'ask' });
});

test('에이전트끼리의 대화 상한은 설정을 따른다', async () => {
  core.settings.update({ threadCap: 2 });
  const a = await create('cap-a');
  const b = await create('cap-b');
  const send = (body: string, threadId?: string) => core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: a.id }, toWorkspaceId: b.id, body, threadId });
  const first = send('1');
  send('2', first.threadId);
  expect(core.messages.threads(projectId)[0]!.capped).toBe(false);
  send('3', first.threadId);
  expect(core.messages.threads(projectId)[0]!.capped).toBe(true);
});

test('"메시지로 띄우기" 를 끄면 꺼진 에이전트는 뜨지 않고, 직접 시작하면 그 메시지가 전달된다', async () => {
  core.settings.update({ autoStartOnMessage: false });
  const front = await started('f5');
  const back = await create('b5');
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '기다리는 메시지' });
  await new Promise((r) => setTimeout(r, 600));
  expect(status(back.id)).toBe('stopped');
  expect(core.delivery.state(back.id)).toBe('waiting-start');
  await core.service.startAgent(back.id, SIZE);
  await until(() => said(back.id).some((t) => t.includes('> 기다리는 메시지')));
});

test('"커밋 뒤 알리기" 를 끄면 커밋해도 에이전트에게 메시지가 가지 않는다', async () => {
  const ws = await started('notify-off');
  core.settings.update({ notifyAgentOnCommit: false });
  writeFileSync(join(ws.worktreePath, 'a.txt'), 'x');
  await core.commit.commit(ws.id, { files: ['a.txt'], message: 'add a' });
  await new Promise((r) => setTimeout(r, 300));
  expect(core.messages.threads(projectId)).toEqual([]);
  core.settings.update({ notifyAgentOnCommit: true });
  writeFileSync(join(ws.worktreePath, 'b.txt'), 'x');
  await core.commit.commit(ws.id, { files: ['b.txt'], message: 'add b' });
  expect(core.messages.threads(projectId).length).toBe(1);
});

test('모델 목록: 에이전트를 띄운 적이 없어도 Claude Code 에게 물어 받아 오고, 저장해 두었다가 다음에 곧바로 쓴다', async () => {
  expect(core.engine.models()).toEqual([]);
  const models = await core.models();
  expect(models).toEqual([{ value: 'default', name: 'Default (recommended)', description: '기본', efforts: ['low', 'medium', 'high'] }, { value: 'claude-opus-5-5', name: 'Opus 5.5', description: '복잡한 일', efforts: [] }]);
  // 물어 오느라 띄운 것은 워크스페이스의 에이전트가 아니고, 남아 있지 않다
  expect(core.workspaces.list(projectId)).toEqual([]);
  // 두 번째는 받아 둔 것을 쓴다 (다시 띄우지 않는다)
  expect(await core.models()).toEqual(models);
  expect(core.settings.savedModels()).toEqual(models);
  // 다시 켜도 곧바로 있다
  await core.dispose();
  await boot();
  expect(core.engine.models()).toEqual(models);
  // 설정 값에는 섞이지 않는다
  expect(Object.keys(core.settings.get())).not.toContain('_models');
});

test('모델 목록: 동시에 여러 번 물어도 한 번만 띄운다. 새로 고침은 다시 묻는다', async () => {
  const [a, b] = await Promise.all([core.models(), core.models()]);
  expect(a).toBe(b);
  expect((await core.models(true)).length).toBe(2);
});

test('모델 목록: Claude Code 가 오류로 끝나면 이유를 알려 준다', async () => {
  await core.dispose();
  extraEnv = { FAKE_CRASH: '1' };
  await boot();
  await expect(core.models()).rejects.toThrow('로그인이 필요합니다');
});

test('채팅 방식의 에이전트가 뜨면 그때 받은 모델 목록도 저장된다', async () => {
  await started('models-live');
  await until(() => core.engine.models().length === 2);
  expect(core.settings.savedModels().length).toBe(2);
});
