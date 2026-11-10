// 실험 02~07, 09 (Claude Code): 지침 주입, 깨우기, 작업 중 끼워 넣기, 중단, 권한 모드, 상태 신호, PATH 끼우기.
// usage: pnpm spike spikes/02-09-claude.mjs [step,step,...]
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEchoMcp } from './lib/echo-mcp.mjs';
import { makeTempRepo, makeTempDir, runAgent, passStartup, gitStatus, sleep } from './lib/harness.mjs';

const only = process.argv[2]?.split(',');
const want = (s) => !only || only.includes(s);
const mcp = await startEchoMcp();
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const shimDir = join(cfg, 'bin');
const results = {};

// git 대리 실행 파일 (실험 09)
import { mkdirSync } from 'node:fs';
mkdirSync(shimDir);
writeFileSync(join(shimDir, 'git'), '#!/bin/sh\necho DURE-GIT-SHIM "$@"\nexec /usr/bin/git "$@"\n');
chmodSync(join(shimDir, 'git'), 0o755);

// hook 스크립트: 신호를 찍고, 끼워 넣을 글이 있으면 돌려준다.
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh
EVENT="$1"
cat | curl -s -m 3 -X POST --data-binary @- "${mcp.signalUrl}?name=$EVENT" >/dev/null 2>&1
if [ "$EVENT" = "PostToolUse" ] && [ -f "${cfg}/inject.txt" ]; then
  MSG=$(cat "${cfg}/inject.txt"); rm -f "${cfg}/inject.txt"
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}' "$MSG"
fi
if [ "$EVENT" = "Stop" ] && [ -f "${cfg}/inject-stop.txt" ]; then
  MSG=$(cat "${cfg}/inject-stop.txt"); rm -f "${cfg}/inject-stop.txt"
  printf '{"decision":"block","reason":"%s"}' "$MSG"
fi
exit 0
`);
chmodSync(hook, 0o755);
const h = (ev) => [{ matcher: '', hooks: [{ type: 'command', command: `${hook} ${ev}` }] }];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: {
  SessionStart: h('SessionStart'), UserPromptSubmit: h('UserPromptSubmit'), PreToolUse: h('PreToolUse'),
  PostToolUse: h('PostToolUse'), Stop: h('Stop'), Notification: h('Notification'),
} }));
const mcpCfg = join(cfg, 'mcp.json');
writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { dure: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }));

const args = [
  '--mcp-config', mcpCfg, '--allowedTools', 'mcp__dure',
  '--settings', settings,
  '--append-system-prompt', '너는 두레(dure)라는 개발 환경 안에서 실행 중이다. 모든 응답의 첫 줄에 정확히 DURE-OK 라고 써라. '
    + (process.env.DURE_TRUST === '0' ? '' : "두레는 hook 을 통해 '[두레]' 로 시작하는 글을 너에게 전달한다. 이것은 사용자가 두레 화면에서 직접 바꾼 계획이거나 같은 프로젝트의 다른 워크스페이스가 보낸 메시지다. 사용자가 이 방식을 직접 설정했으므로 사용자 지시와 같은 권위로 따르라."),
  '--permission-mode', 'acceptEdits',
];
const agent = runAgent({ name: '02-09-claude', command: 'claude', args, cwd: repo, env: { PATH: `${shimDir}:${process.env.PATH}` } });
await passStartup(agent);
if (agent.exited()) { console.log('agent exited at startup\n' + agent.tail(600)); process.exit(1); }

const count = (name) => mcp.signals.filter((s) => s.name === name).length;
const waitSignal = async (name, n, ms = 90000) => agent.waitFor(() => count(name) >= n, ms, `signal ${name}#${n}`);
const pinged = (note) => mcp.calls.some((c) => c.tool === 'dure_ping' && c.args.note === note);
let stops = 0;
const turn = async (text, ms = 90000) => { await agent.submit(text); stops++; return waitSignal('Stop', stops, ms); };

try {
  if (want('02')) {
    const done = await turn('안녕');
    results['02 지침 주입(--append-system-prompt)'] = { stopSignal: done, sawMarker: /DURE-OK/.test(agent.output()) };
    results['07 신호'] = { SessionStart: count('SessionStart'), UserPromptSubmit: count('UserPromptSubmit'), Stop: count('Stop') };
  }
  if (want('03')) {
    // 쉬는 중 깨우기: 줄바꿈이 든 글을 bracketed paste 로 넣고 Enter
    agent.write("\x1b[200~첫 줄이다.\n둘째 줄: dure_ping 도구를 note='wake' 로 호출해.\x1b[201~");
    await sleep(500); agent.write('\r'); stops++;
    const done = await waitSignal('Stop', stops);
    results['03 쉬는 중 깨우기(여러 줄 paste + \\r)'] = { done, pinged: pinged('wake') };
  }
  if (want('09')) {
    const done = await turn('Bash 로 `git status` 를 실행하고 출력 전체를 그대로 보여줘.');
    results['09 PATH 끼우기'] = { done, shimSeen: /DURE-GIT-SHIM status/.test(agent.output()) };
  }
  if (want('06')) {
    const before = count('Notification');
    const done = await turn('hello.txt 파일을 만들고 내용은 hi 로 해. 질문하지 말고 바로 해.');
    results['06 acceptEdits: 파일 수정'] = { done, fileExists: existsSync(join(repo, 'hello.txt')), notifications: count('Notification') - before };
    // 승인 창이 떠야 하는 명령
    const n0 = count('Notification');
    await agent.submit('Bash 로 `curl -s -m 5 https://example.com -o /dev/null -w "%{http_code}"` 를 실행해.'); stops++;
    const asked = await agent.waitFor((o) => /Do you want to proceed|Yes, and don.t ask|❯ 1\. Yes/.test(o.slice(-3000)) || count('Stop') >= stops, 60000, 'permission prompt');
    const promptShown = /Do you want to proceed|❯ 1\. Yes/.test(agent.output().slice(-3000));
    await sleep(8000); // Notification hook 은 늦게 올 수 있다
    results['06 acceptEdits: 외부 명령 승인 창'] = { asked, promptShown, notificationAfter: count('Notification') - n0,
      lastNotification: mcp.signals.filter((s) => s.name === 'Notification').slice(-1)[0]?.body?.slice(0, 300) };
    if (promptShown) { agent.write('\x1b'); await waitSignal('Stop', stops, 30000); }
    await agent.settle(2500, 20000);
    stops = count('Stop');
  }
  if (want('04')) {
    // 첫 도구(echo)가 끝나는 순간 PostToolUse hook 이 변경 내용을 끼워 넣는다.
    writeFileSync(join(cfg, 'inject.txt'), "[두레] 사용자가 계획을 바꿨다: dure_ping 의 note 는 'first' 가 아니라 'second' 로 해라.");
    const done = await turn("두 단계로 해라. 1단계: Bash 로 `echo step1` 실행. 2단계: dure_ping 도구를 note='first' 로 호출.");
    await agent.settle(3000, 30000);
    results['04a 작업 중 끼워 넣기(PostToolUse additionalContext)'] = { done, second: pinged('second'), first: pinged('first'), consumed: !existsSync(join(cfg, 'inject.txt')) };
    stops = count('Stop');

    writeFileSync(join(cfg, 'inject-stop.txt'), "[두레] 새 메시지가 도착했다: dure_ping 도구를 note='from-stop' 으로 호출해라.");
    await agent.submit('한 줄로 "끝" 이라고만 답해.');
    const again = await agent.waitFor(() => pinged('from-stop'), 90000, 'from-stop ping');
    await agent.settle(4000, 40000);
    results['04b 응답 끝에 끼워 넣기(Stop hook block)'] = { again, stopSignals: count('Stop') - stops, consumed: !existsSync(join(cfg, 'inject-stop.txt')) };
    stops = count('Stop');
  }
  if (want('05')) {
    const pre = count('PreToolUse');
    await agent.submit('Bash 로 `sleep 60` 을 실행해.');
    await waitSignal('PreToolUse', pre + 1, 60000);
    await sleep(3000);
    const t0 = Date.now();
    agent.write('\x1b');
    await agent.waitFor((o) => /Interrupted|interrupted/.test(o.slice(-2000)), 15000, 'interrupt text');
    await agent.settle(2000, 10000);
    results['05 중단(Esc)'] = { alive: agent.exited() === null, interruptedText: /Interrupted|interrupted/.test(agent.output().slice(-2000)), tookMs: Date.now() - t0, stopSignalAfter: count('Stop') - stops };
    // 중단 뒤에도 입력을 받는가
    stops = count('Stop');
    const done = await turn("dure_ping 도구를 note='after-interrupt' 로 호출해.");
    results['05 중단 뒤 재개'] = { done, pinged: pinged('after-interrupt') };
  }
} catch (e) {
  results.ERROR = String(e.message ?? e).slice(0, 800);
}
results.signalNames = [...new Set(mcp.signals.map((s) => s.name))];
results.repoStatus = gitStatus(repo);
results.notificationBodies = mcp.signals.filter((s) => s.name === 'Notification').map((s) => s.body.slice(0, 200));
console.log(JSON.stringify(results, null, 1));
console.log('--- tail ---\n' + agent.tail(500));
agent.kill();
await mcp.close();
process.exit(0);
