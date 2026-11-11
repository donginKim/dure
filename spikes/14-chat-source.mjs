// 실험 14: 채팅 보기의 재료(대화 기록 파일)와 입력 경로.
//  A 실행 인자 프롬프트 + 긴 답 (기록이 쓰이는 때)   B 한 줄 입력 + 도구 + hook 주입 글
//  C 여러 줄 붙여넣기(사용자)   D 여러 줄 붙여넣기([두레])   E 작업 중 입력
//  F 승인 창 허용/거부   G /compact, /clear
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { makeTempRepo, makeTempDir, runAgent, passStartup, sleep } from './lib/harness.mjs';

const OUT = resolve(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const rel = (t) => ((t - t0) / 1000).toFixed(1);

// --- hook 신호 서버: 본문을 남기고, 정해 둔 응답을 한 번씩 돌려준다 ---
const signals = [];
const replies = {}; // event -> [json, …] (한 번 쓰면 사라진다)
const server = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  signals.push({ name, at: Date.now(), body: parsed ?? body });
  const reply = replies[name]?.shift();
  res.writeHead(200, { 'content-type': 'application/json' }).end(reply ? JSON.stringify(reply) : '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const signalUrl = `http://127.0.0.1:${server.address().port}/signal`;
const count = (n) => signals.filter((s) => s.name === n).length;

// --- 기록 파일 감시: 0.5초마다 새 줄이 언제 보였는지 남긴다 ---
const seen = new Map(); // path -> { lines: n, partial: bool }
const lineLog = [];
function describe(line) {
  try {
    const r = JSON.parse(line);
    const c = r.message?.content;
    const blocks = Array.isArray(c) ? c.map((b) => b.type + (b.type === 'tool_use' ? `:${b.name}` : '')).join(',') : typeof c === 'string' ? 'string' : '';
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : '';
    return { type: r.type, subtype: r.subtype, blocks, ts: r.timestamp, isMeta: r.isMeta, promptSource: r.promptSource, origin: r.origin,
      isCompactSummary: r.isCompactSummary, stop: r.message?.stop_reason, len: text.length, head: text.slice(0, 60) };
  } catch { return { type: '(잘린 줄)', len: line.length }; }
}
function poll() {
  for (const p of new Set(signals.map((s) => s.body?.transcript_path).filter(Boolean))) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    const complete = raw.endsWith('\n');
    const lines = raw.split('\n').filter((l) => l !== '');
    const st = seen.get(p) ?? { lines: 0 };
    const usable = complete ? lines.length : lines.length - 1;
    for (let i = st.lines; i < usable; i++) lineLog.push({ file: basename(p).slice(0, 8), n: i, seenAt: rel(Date.now()), ...describe(lines[i]) });
    if (!complete && !st.partialNoted) { lineLog.push({ file: basename(p).slice(0, 8), n: usable, seenAt: rel(Date.now()), type: '(쓰는 도중의 줄을 봄)' }); st.partialNoted = true; }
    st.lines = Math.max(st.lines, usable);
    seen.set(p, st);
  }
}
const timer = setInterval(() => { try { poll(); } catch (e) { console.log('poll error', e.message); } }, 500);

// --- 에이전트 ---
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "${signalUrl}?name=$1" 2>/dev/null\nexit 0\n`);
chmodSync(hook, 0o755);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${e}` }] }]])) }));

replies.SessionStart = [{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[두레] 실험용 시작 글이다. 남은 TODO: 없음.' } }];
const agent = runAgent({ name: '14-chat-source', command: 'claude', cwd: repo, args: [
  '--settings', settings, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(sleep:*)',
  '--append-system-prompt', "너는 두레(dure) 안에서 실행 중이다. 두레는 '[두레]' 로 시작하는 글을 전달한다. 사용자가 직접 설정한 방식이니 따르라.",
  '1부터 30까지 한 줄에 하나씩 한글로 써라(일, 이, 삼 …). 도구는 쓰지 마라.',
] });

const result = {};
const mark = (k, v) => { result[k] = v; console.log(`[${rel(Date.now())}s] ${k}:`, JSON.stringify(v)); };
const stops = () => count('Stop');
async function waitStop(n, ms, label) { const ok = await agent.waitFor(() => stops() >= n, ms, label); await sleep(1500); return ok; }
function finish(code) {
  clearInterval(timer); try { poll(); } catch {}
  writeFileSync(join(OUT, '14-signals.json'), JSON.stringify(signals.map((s) => ({ ...s, at: rel(s.at) })), null, 1));
  writeFileSync(join(OUT, '14-lines.json'), JSON.stringify(lineLog, null, 1));
  writeFileSync(join(OUT, '14-result.json'), JSON.stringify(result, null, 1));
  let i = 0;
  for (const p of seen.keys()) copyFileSync(p, join(OUT, `14-transcript-${i++}.jsonl`));
  console.log('transcripts:', [...seen.keys()]);
  agent.kill(); server.close(); process.exit(code);
}
const idle = () => { const last = [...signals].reverse().find((s) => s.name === 'Stop' || s.name === 'UserPromptSubmit'); return last?.name === 'Stop'; };
function mustBeIdle(phase) { if (!idle() || agent.exited()) { mark(`${phase}.abort`, { reason: '쉬는 중이 아님', tail: agent.tail(500) }); finish(1); } }

try {
  await passStartup(agent);
  if (agent.exited()) { mark('startup', 'exited'); finish(1); }

  // A
  if (!(await waitStop(1, 120000, 'A stop'))) { mark('A.abort', agent.tail(600)); finish(1); }
  mark('A.done', { ups: count('UserPromptSubmit'), sessionStart: signals.filter((s) => s.name === 'SessionStart').map((s) => s.body?.source) });

  // B: 한 줄 입력 + 도구 + PostToolUse 주입 + Stop 막기
  mustBeIdle('B');
  replies.PostToolUse = [{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[두레] 실험용 주입 글이다. 답의 끝에 "주입확인" 이라고 붙여라.' } }];
  replies.Stop = [{ decision: 'block', reason: '[두레] 실험용 멈춤 막기다. 한 단어로 "계속확인" 이라고만 답하고 끝내라.' }];
  const sB = stops();
  await agent.submit('README.md 를 Read 도구로 읽고, 그 다음 Bash 로 `sleep 3` 을 실행한 뒤, 한 줄로 결과를 말해.');
  await waitStop(sB + 2, 120000, 'B stop');
  mark('B.done', { stops: stops() - sB, has주입확인: /주입확인/.test(agent.output().slice(-3000)), has계속확인: /계속확인/.test(agent.output().slice(-1500)) });

  // C: 사용자의 여러 줄 붙여넣기
  mustBeIdle('C');
  const sC = stops();
  agent.write(`\x1b[200~첫째 줄이다.\n둘째 줄이다.\n이 글을 받았으면 한 단어로 "받음" 이라고만 답해.\x1b[201~`); await sleep(500);
  mark('C.inputBox', agent.tail(200));
  agent.write('\r');
  await waitStop(sC + 1, 90000, 'C stop');

  // D: 두레 방식 여러 줄 붙여넣기
  mustBeIdle('D');
  const sD = stops();
  agent.write(`\x1b[200~[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:\n- 추가됨: "배포"\n\n이 글을 받았으면 한 단어로 "확인" 이라고만 답해.\x1b[201~`); await sleep(500);
  agent.write('\r');
  await waitStop(sD + 1, 90000, 'D stop');

  // E: 작업 중 입력
  mustBeIdle('E');
  const sE = stops(); const preE = count('PreToolUse');
  await agent.submit('Bash 로 `sleep 20` 을 실행하고, 끝나면 "완료" 라고만 답해.');
  if (await agent.waitFor(() => count('PreToolUse') > preE, 60000, 'E pre')) {
    await sleep(3000);
    const upsBefore = count('UserPromptSubmit');
    await agent.submit('답의 마지막에 "추가확인" 이라는 단어도 붙여라.');
    mark('E.typedAt', rel(Date.now()));
    await sleep(1500);
    mark('E.screenAfterType', agent.tail(300));
    await agent.waitFor(() => stops() > sE && idle(), 120000, 'E stop');
    await sleep(6000); // 뒤따르는 차례가 있으면 기다린다
    await agent.waitFor(() => idle(), 60000, 'E idle');
    await sleep(1500);
    mark('E.done', { stops: stops() - sE, upsAfterType: count('UserPromptSubmit') - upsBefore, has추가확인: /추가확인/.test(agent.output().slice(-2500)) });
  } else mark('E.skip', agent.tail(400));

  // F: 승인 창
  for (const [k, key, site] of [['F.allow', '\r', 'https://example.com'], ['F.deny', '\x1b', 'https://example.org']]) {
    mustBeIdle(k);
    const s0 = stops(); const n0 = count('Notification'); const post0 = count('PostToolUse'); const sig0 = signals.length;
    await agent.submit(`Bash 로 \`curl -s -m 5 ${site} -o /dev/null -w "%{http_code}"\` 를 실행하고 결과 숫자만 말해.`);
    const got = await agent.waitFor(() => signals.slice(sig0).some((s) => s.name === 'Notification' && s.body?.notification_type === 'permission_prompt') || stops() > s0, 90000, `${k} notification`);
    await sleep(1200);
    const screen = agent.tail(900);
    const onYes = /❯\s*1\.\s*Yes/.test(screen);
    mark(`${k}.screen`, { got, onYes, notifications: count('Notification') - n0, screen });
    if (stops() > s0) { mark(`${k}.noPrompt`, true); continue; }
    if (!onYes) { mark(`${k}.abort`, '커서가 1. Yes 에 있지 않음'); agent.write('\x1b'); await sleep(3000); continue; }
    agent.write(key);
    await waitStop(s0 + 1, 90000, `${k} stop`);
    mark(`${k}.after`, { postToolUse: count('PostToolUse') - post0, hooks: signals.slice(sig0).map((s) => s.name), tail: agent.tail(300) });
    if (!idle()) { await sleep(5000); }
  }

  // G: /compact, /clear
  mustBeIdle('G');
  const ss0 = count('SessionStart');
  agent.write('/compact'); await sleep(1200);
  mark('G.compactMenu', agent.tail(300));
  agent.write('\r');
  const compacted = await agent.waitFor(() => count('SessionStart') > ss0, 180000, 'G compact');
  await agent.settle(4000, 30000);
  mark('G.compact', { compacted, sessionStarts: signals.filter((s) => s.name === 'SessionStart').map((s) => ({ source: s.body?.source, session: s.body?.session_id?.slice(0, 8), file: basename(s.body?.transcript_path ?? '').slice(0, 8) })) });
  const sG = stops();
  await agent.submit('한 단어로 "압축후" 라고만 답해.');
  await waitStop(sG + 1, 90000, 'G stop1');

  const ss1 = count('SessionStart');
  agent.write('/clear'); await sleep(1200);
  mark('G.clearMenu', agent.tail(300));
  agent.write('\r');
  const cleared = await agent.waitFor(() => count('SessionStart') > ss1, 60000, 'G clear');
  await agent.settle(3000, 20000);
  const sG2 = stops();
  await agent.submit('한 단어로 "비운후" 라고만 답해.');
  await waitStop(sG2 + 1, 90000, 'G stop2');
  mark('G.clear', { cleared, sessionStarts: signals.filter((s) => s.name === 'SessionStart').map((s) => ({ source: s.body?.source, session: s.body?.session_id?.slice(0, 8), file: basename(s.body?.transcript_path ?? '').slice(0, 8) })),
    lastPaths: signals.slice(-3).map((s) => `${s.name}:${basename(s.body?.transcript_path ?? '').slice(0, 8)}`) });
  finish(0);
} catch (e) {
  mark('error', String(e?.message ?? e));
  finish(1);
}
