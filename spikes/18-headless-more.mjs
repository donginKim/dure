// 실험 18: 헤드리스 방식의 나머지. 초기화 응답(명령 설명), 슬래시 명령, 거부, 여러 선택지 질문, 작업 중 입력, 멈춤, 이어가기.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanEnv, makeTempRepo, sleep } from './lib/harness.mjs';

const repo = makeTempRepo();
function start(extra = []) {
  const child = spawn('claude', ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits', ...extra], { cwd: repo, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, events: [], exited: null, err: '' };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { try { s.events.push({ at: Date.now(), ...JSON.parse(line) }); } catch { s.events.push({ raw: line.slice(0, 200) }); } } } });
  child.stderr.on('data', (d) => { s.err += d; });
  child.on('exit', (c) => { s.exited = c; });
  s.send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  s.say = (text) => s.send({ type: 'user', message: { role: 'user', content: text } });
  s.results = () => s.events.filter((e) => e.type === 'result').length;
  s.wait = async (pred, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; if (s.exited !== null) return false; await sleep(150); } console.log('[timeout]', label); return false; };
  s.control = async (request, ms = 15000) => { const id = 'req_' + Math.random().toString(36).slice(2); s.send({ type: 'control_request', request_id: id, request }); await s.wait(() => s.events.some((e) => e.type === 'control_response' && e.response?.request_id === id), ms, 'control ' + request.subtype); return s.events.find((e) => e.type === 'control_response' && e.response?.request_id === id)?.response; };
  return s;
}
const short = (v, n = 400) => JSON.stringify(v)?.slice(0, n);
const out = {};
const s = start();
let policy = 'allow';
const pending = [];
const timer = setInterval(() => {
  for (const e of s.events) {
    if (e.type !== 'control_request' || e._done) continue;
    e._done = true; pending.push(e);
    const r = e.request ?? {};
    if (r.subtype !== 'can_use_tool') continue;
    let response;
    if (r.tool_name === 'AskUserQuestion') {
      const q = r.input?.questions?.[0];
      response = { behavior: 'allow', updatedInput: { ...r.input, answers: { [q?.question]: q?.options?.[1]?.label } } };
    } else response = policy === 'allow' ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: '사용자가 거부했습니다.' };
    s.send({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response } });
  }
}, 150);

// g) 초기화 응답
const init = await s.control({ subtype: 'initialize' });
out.initialize = { keys: Object.keys(init?.response ?? init ?? {}), commands: (init?.response?.commands ?? []).slice(0, 6), commandCount: init?.response?.commands?.length, models: (init?.response?.models ?? []).slice(0, 3), raw: short(init, 300) };

// d) 슬래시 명령
let r0 = s.results();
s.say('/context');
await s.wait(() => s.results() > r0, 30000, '/context');
out.slashContext = s.events.slice(-6).map((e) => `${e.type}${e.subtype ? '/' + e.subtype : ''}: ${short(e.result ?? e.message?.content ?? e.content ?? '', 160)}`);

// f) 거부
policy = 'deny'; r0 = s.results();
s.say('Bash 로 `curl -s -m 5 https://example.org -o /dev/null -w "%{http_code}"` 를 실행해. 안 되면 "거부됨" 이라고만 답해.');
await s.wait(() => s.results() > r0, 90000, 'deny');
out.deny = { request: short(pending.find((p) => p.request?.tool_name === 'Bash')?.request, 500), result: s.events.filter((e) => e.type === 'result').at(-1)?.result?.slice(0, 80) };
policy = 'allow';

// a) 여러 선택지 질문
r0 = s.results();
s.say('AskUserQuestion 도구로 "어떤 색을 쓸까요?" 를 물어라. 선택지는 빨강, 파랑, 초록. 내 답을 받으면 그 색 이름만 말해.');
await s.wait(() => s.results() > r0, 90000, 'ask');
const ask = pending.find((p) => p.request?.tool_name === 'AskUserQuestion');
out.ask = { request: short(ask?.request, 900), result: s.events.filter((e) => e.type === 'result').at(-1)?.result?.slice(0, 80) };

// e) 작업 중 입력, b) 멈춤
r0 = s.results();
s.say('Bash 로 `sleep 12` 를 실행하고 끝나면 "완료" 라고만 답해.');
await s.wait(() => s.events.some((e) => e.type === 'assistant' && JSON.stringify(e.message?.content ?? '').includes('sleep 12')), 60000, 'sleep start');
await sleep(2000);
const n0 = s.events.length;
s.say('답의 마지막에 "추가확인" 도 붙여라.');
await s.wait(() => s.results() > r0, 60000, 'mid');
await sleep(3000); await s.wait(() => !s.events.slice(-1)[0] || s.events.slice(-1)[0].type === 'result', 30000, 'settle');
out.midTurn = { results: s.events.filter((e) => e.type === 'result').slice(r0).map((r) => r.result?.slice(0, 60)), kinds: [...new Set(s.events.slice(n0).map((e) => e.type + (e.subtype ? '/' + e.subtype : '')))] };

r0 = s.results();
s.say('Bash 로 `sleep 30` 을 실행하고 끝나면 "완료" 라고만 답해.');
await s.wait(() => s.events.some((e) => e.type === 'assistant' && JSON.stringify(e.message?.content ?? '').includes('sleep 30')), 60000, 'sleep30 start');
await sleep(2500);
const t0 = Date.now();
const intr = await s.control({ subtype: 'interrupt' });
await s.wait(() => s.results() > r0, 20000, 'interrupt result');
out.interrupt = { response: short(intr, 200), tookMs: Date.now() - t0, result: short(s.events.filter((e) => e.type === 'result').at(-1), 300) };

// 멈춘 뒤에도 이어서 쓸 수 있는가
r0 = s.results();
s.say('한 단어로 "살아있음" 이라고만 답해.');
await s.wait(() => s.results() > r0, 60000, 'alive');
out.afterInterrupt = s.events.filter((e) => e.type === 'result').at(-1)?.result;
const sessionId = s.events.find((e) => e.session_id)?.session_id;
clearInterval(timer); s.child.stdin.end(); await sleep(1500); s.child.kill();
writeFileSync(resolve(import.meta.dirname, 'out/18-events.json'), JSON.stringify(s.events.map(({ _done, ...e }) => e), null, 1));

// c) 이어가기: 새 프로세스로 같은 대화를
const s2 = start(['--resume', sessionId, '--replay-user-messages']);
s2.say('방금 전에 내가 고른 색이 뭐였지? 색 이름만 말해.');
await s2.wait(() => s2.results() >= 1, 90000, 'resume');
out.resume = { sameSession: s2.events.find((e) => e.session_id)?.session_id === sessionId, answer: s2.events.filter((e) => e.type === 'result').at(-1)?.result?.slice(0, 60), replayed: s2.events.filter((e) => e.type === 'user').length, kinds: [...new Set(s2.events.map((e) => e.type + (e.subtype ? '/' + e.subtype : '')))], err: s2.err.slice(0, 200) };
s2.child.stdin.end(); await sleep(1000); s2.child.kill();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
