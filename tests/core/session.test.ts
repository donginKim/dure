import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentSession, type AgentEvent } from '@core/agents/session';
import { tempDir } from '../helpers/repo';

// 가짜 에이전트: 받은 줄을 보고 정해진 이벤트를 낸다. node 로 돈다 (테스트는 Electron 의 node 로 실행된다).
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's-1' });
process.stdout.write('경고: JSON 이 아닌 줄\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'user') {
    if (m.message.content === 'split') { process.stdout.write('{"type":"assi'); setTimeout(() => process.stdout.write('stant","text":"쪼개진 줄"}\\n'), 30); return; }
    if (m.message.content === 'ask') { out({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }); return; }
    if (m.message.content === 'die') { process.stderr.write('치명적 오류\\n'); process.exit(3); }
    out({ type: 'result', result: 'echo:' + m.message.content });
  } else if (m.type === 'control_request') {
    if (m.request.subtype === 'never') return;
    if (m.request.subtype === 'bad') { out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: '모르는 요청' } }); return; }
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { got: m.request.subtype } } });
  } else if (m.type === 'control_response') {
    out({ type: 'result', result: 'answered:' + m.response.request_id + ':' + m.response.response.behavior });
  }
});
rl.on('close', () => process.exit(0));
`;

let script: string;
let session: AgentSession;
const events: AgentEvent[] = [];
const until = (cond: () => boolean, ms = 4000): Promise<void> => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = (): void => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : void setTimeout(tick, 15));
  tick();
});

beforeEach(() => {
  events.length = 0;
  script = join(tempDir(), 'fake agent.js');
  writeFileSync(script, FAKE);
  chmodSync(script, 0o755);
  session = new AgentSession({ command: process.execPath, args: [script], cwd: tempDir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> });
  session.on('event', (e: AgentEvent) => events.push(e));
});
afterEach(() => session.kill());

test('표준 출력의 JSON 줄을 이벤트로 내고, JSON 이 아닌 줄은 버린다', async () => {
  await until(() => events.length >= 1);
  expect(events[0]).toEqual({ type: 'system', subtype: 'init', session_id: 's-1' });
  session.say('안녕');
  await until(() => events.some((e) => e.type === 'result'));
  expect(events.at(-1)).toEqual({ type: 'result', result: 'echo:안녕' });
  expect(events.length).toBe(2);
});

test('여러 조각으로 나뉘어 온 한 줄을 이어 붙인다', async () => {
  session.say('split');
  await until(() => events.some((e) => e.type === 'assistant'));
  expect(events.at(-1)).toMatchObject({ text: '쪼개진 줄' });
});

test('control 은 같은 id 의 답을 돌려주고, 그 답은 이벤트로 내지 않는다', async () => {
  await expect(session.control({ subtype: 'interrupt' })).resolves.toEqual({ got: 'interrupt' });
  expect(events.some((e) => e.type === 'control_response')).toBe(false);
});

test('control: 오류 답은 거절, 답이 없으면 시간 초과', async () => {
  await expect(session.control({ subtype: 'bad' })).rejects.toThrow('모르는 요청');
  await expect(session.control({ subtype: 'never' }, 100)).rejects.toThrow('에이전트가 응답하지 않습니다.');
});

test('에이전트가 물어 온 것에 respond 로 답한다', async () => {
  session.say('ask');
  await until(() => events.some((e) => e.type === 'control_request'));
  session.respond('r-1', { behavior: 'allow', updatedInput: { command: 'ls' } });
  await until(() => events.some((e) => e.type === 'result'));
  expect(events.at(-1)).toMatchObject({ result: 'answered:r-1:allow' });
});

test('프로세스가 끝나면 exit 이 한 번 나고, 기다리던 요청은 거절되고, 그 뒤의 say 는 오류', async () => {
  const exits: [number | null, string][] = [];
  session.on('exit', (code: number | null, stderr: string) => exits.push([code, stderr]));
  const waiting = session.control({ subtype: 'never' }, 5000);
  session.say('die');
  await expect(waiting).rejects.toThrow('에이전트가 종료되었습니다.');
  await until(() => exits.length === 1);
  expect(exits[0]![0]).toBe(3);
  expect(exits[0]![1]).toContain('치명적 오류');
  expect(session.alive).toBe(false);
  expect(() => session.say('뒤늦게')).toThrow('에이전트가 종료되었습니다.');
});

test('kill 하면 끝난다', async () => {
  let exited = false;
  session.on('exit', () => { exited = true; });
  session.kill();
  await until(() => exited);
});

test('없는 실행 파일이면 exit 이 난다 (던지지 않는다)', async () => {
  const s = new AgentSession({ command: '/nonexistent/claude', args: [], cwd: tempDir(), env: {} });
  let got = false;
  s.on('exit', () => { got = true; });
  await until(() => got);
  expect(s.alive).toBe(false);
});

test('끄면 에이전트가 띄운 자식 프로세스까지 끝난다', async () => {
  const dir = tempDir();
  const pidFile = join(dir, 'child.pid');
  const parent = join(dir, 'parent.js');
  // 자식은 SIGTERM 을 무시하지 않는 보통의 오래 도는 프로세스다 (개발 서버 같은 것).
  writeFileSync(parent, `
const { spawn } = require('node:child_process');
const child = spawn('/bin/sh', ['-c', 'sleep 300'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdin.resume();
`);
  const s = new AgentSession({ command: process.execPath, args: [parent], cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> });
  const got: AgentEvent[] = [];
  s.on('event', (e: AgentEvent) => got.push(e));
  await until(() => got.length >= 1);
  const childPid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));
  const aliveNow = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(aliveNow(childPid)).toBe(true);
  s.kill();
  await until(() => !s.alive && !aliveNow(childPid), 5000);
  expect(aliveNow(childPid)).toBe(false);
});

test('줄바꿈 없이 너무 긴 줄은 버리고, 그 뒤의 줄은 정상으로 받는다', async () => {
  const dir = tempDir();
  const big = join(dir, 'big.js');
  writeFileSync(big, `
const chunk = 'x'.repeat(1 << 20);
let n = 0;
const more = () => {
  if (n++ < 18) { process.stdout.write(chunk, more); return; }
  process.stdout.write('tail of the long line\\n' + JSON.stringify({ type: 'result', result: 'after' }) + '\\n');
};
more();
process.stdin.resume();
`);
  const s = new AgentSession({ command: process.execPath, args: [big], cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> });
  const got: AgentEvent[] = [];
  s.on('event', (e: AgentEvent) => got.push(e));
  await until(() => got.length >= 1, 15000);
  expect(got).toEqual([{ type: 'result', result: 'after' }]);
  expect((s as unknown as { buffer: string }).buffer.length).toBeLessThan(1 << 20);
  s.kill();
}, 20000);
