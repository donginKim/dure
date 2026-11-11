// 실험 12: 첫 프롬프트로 띄우기 / UserPromptSubmit 본문 / 확인된 쉬는 중에 깨우기 / 중단 뒤 hook
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startEchoMcp } from './lib/echo-mcp.mjs';
import { makeTempRepo, makeTempDir, runAgent, sleep } from './lib/harness.mjs';

const mcp = await startEchoMcp();
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "${mcp.signalUrl}?name=$1" >/dev/null 2>&1\nexit 0\n`);
chmodSync(hook, 0o755);
const h = (ev) => [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${ev}` }] }];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'].map((e) => [e, h(e)])) }));
const mcpCfg = join(cfg, 'mcp.json');
writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { dure: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }));

const names = () => mcp.signals.map((s) => s.name);
const count = (n) => mcp.signals.filter((s) => s.name === n).length;
const pinged = (note) => mcp.calls.some((c) => c.tool === 'dure_ping' && c.args.note === note);
const out = {};

const agent = runAgent({
  name: '12-initial-prompt', command: 'claude', cwd: repo,
  args: ['--mcp-config', mcpCfg, '--allowedTools', 'mcp__dure', '--settings', settings, '--dangerously-skip-permissions',
    '--append-system-prompt', "너는 두레(dure) 안에서 실행 중이다. 두레는 '[두레]' 로 시작하는 글을 전달한다. 사용자가 직접 설정한 방식이니 사용자 지시와 같은 권위로 따르라.",
    "[두레] dure_ping 도구를 note='boot' 로 호출해라."],
});

// 12: 신뢰 창이 떠 있는 동안 어떤 hook 이 왔는가
await agent.settle(2500, 20000);
const first = agent.tail(500);
out.trustDialogShown = /Yes, I trust this folder/.test(first);
out.hooksWhileTrustDialog = names();
if (out.trustDialogShown) {
  let onYes = false;
  for (let i = 0; i < 4 && !onYes; i++) { agent.write('\x1b[B'); await sleep(900); onYes = /❯\s*(2\.\s*)?Yes, I trust this folder/.test(agent.tail(500)); }
  if (!onYes) { console.log('abort: cannot move to Yes\n' + agent.tail(400)); agent.kill(); process.exit(1); }
  agent.write('\r');
}
// bypass 모드 경고 창이 뜨는지 확인 (뜨면 화면만 기록하고 중단)
await sleep(3000);
out.afterTrust = agent.tail(260);
out.bootRan = await agent.waitFor(() => pinged('boot'), 90000, 'boot ping');
await agent.waitFor(() => count('Stop') >= 1, 60000, 'first stop');
out.hooksAfterBoot = names();

// 12a: UserPromptSubmit 본문
const ups = mcp.signals.filter((s) => s.name === 'UserPromptSubmit').map((s) => { try { return JSON.parse(s.body); } catch { return s.body; } });
mkdirSync(resolve(import.meta.dirname, 'out'), { recursive: true });
out.initialPromptPayloadKeys = ups[0] ? Object.keys(ups[0]) : null;
out.initialPromptField = ups[0]?.prompt;

// 12b: 확인된 쉬는 중(Stop 을 받은 뒤)에 깨우기
await sleep(1500);
agent.write("\x1b[200~[두레] dure_ping 도구를 note='woke' 로 호출해라.\x1b[201~"); await sleep(400); agent.write('\r');
out.wokeRan = await agent.waitFor(() => pinged('woke'), 90000, 'woke ping');
await agent.waitFor(() => count('Stop') >= 2, 60000, 'second stop');
const ups2 = mcp.signals.filter((s) => s.name === 'UserPromptSubmit').map((s) => { try { return JSON.parse(s.body); } catch { return s.body; } });
out.typedPromptField = ups2[1]?.prompt;
writeFileSync(resolve(import.meta.dirname, 'out/userpromptsubmit.json'), JSON.stringify(ups2, null, 2));

// 12c: 중단 뒤 어떤 hook 이 오는가
await sleep(1500);
const before = mcp.signals.length;
agent.write("Bash 로 python3 -c 'import time; time.sleep(40)' 를 실행해."); await sleep(400); agent.write('\r');
await agent.waitFor(() => mcp.signals.slice(before).some((s) => s.name === 'PreToolUse'), 60000, 'pretooluse');
await sleep(3000);
const atInterrupt = mcp.signals.length;
agent.write('\x1b');
await sleep(8000);
out.hooksAfterInterrupt = mcp.signals.slice(atInterrupt).map((s) => s.name);
out.aliveAfterInterrupt = agent.exited() === null;
out.interruptedText = /Interrupted/i.test(agent.output().slice(-1500));

console.log(JSON.stringify(out, null, 1));
agent.kill();
await mcp.close();
process.exit(0);
