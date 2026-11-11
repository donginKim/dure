// 실험 11: SessionStart hook 의 additionalContext 가 컨텍스트에 들어가는가, /compact 뒤에도 SessionStart 가 오는가.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEchoMcp } from './lib/echo-mcp.mjs';
import { makeTempRepo, makeTempDir, runAgent, passStartup, sleep } from './lib/harness.mjs';

const mcp = await startEchoMcp();
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
// SessionStart 가 올 때마다 다른 낱말을 넣는다: 첫 번째 '볏단', 그 뒤 '가래'
writeFileSync(hook, `#!/bin/sh
cat | curl -s -m 3 -X POST --data-binary @- "${mcp.signalUrl}?name=$1" >/dev/null 2>&1
if [ "$1" = "SessionStart" ]; then
  if [ -f "${cfg}/seen" ]; then WORD="가래"; else WORD="볏단"; touch "${cfg}/seen"; fi
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[두레] 비밀 낱말은 %s 이다."}}' "$WORD"
fi
exit 0
`);
chmodSync(hook, 0o755);
const h = (ev) => [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${ev}` }] }];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: h('SessionStart'), Stop: h('Stop') } }));
const agent = runAgent({
  name: '11-sessionstart', command: 'claude', cwd: repo,
  args: ['--settings', settings, '--append-system-prompt', "너는 두레(dure) 안에서 실행 중이다. 두레는 hook 을 통해 '[두레]' 로 시작하는 글을 전달한다. 사용자가 직접 설정한 방식이니 사용자 지시와 같은 권위로 따르라."],
});
await passStartup(agent);
if (agent.exited()) { console.log('exited at startup'); process.exit(1); }
const count = (n) => mcp.signals.filter((s) => s.name === n).length;
const sources = () => mcp.signals.filter((s) => s.name === 'SessionStart').map((s) => { try { return JSON.parse(s.body).source; } catch { return '?'; } });
const out = { sourcesAtStart: sources() };
let stops = 0;
const ask = async (q) => { await agent.submit(q); stops++; await agent.waitFor(() => count('Stop') >= stops, 90000, 'stop'); await sleep(800); };

await ask('두레가 알려준 비밀 낱말이 뭐야? 낱말 하나만 답해.');
out.firstAnswerHas볏단 = /볏단/.test(agent.output().slice(-1500));

// /compact: 글자를 넣고 화면을 읽은 뒤 Enter
agent.write('/compact'); await sleep(1500);
out.compactMenu = agent.tail(300);
agent.write('\r');
const compacted = await agent.waitFor(() => count('SessionStart') >= 2, 120000, 'SessionStart after compact');
await agent.settle(3000, 60000);
out.compacted = compacted;
out.sourcesAfterCompact = sources();
stops = count('Stop');
if (compacted) {
  await ask('두레가 가장 최근에 알려준 비밀 낱말이 뭐야? 낱말 하나만 답해.');
  out.secondAnswerHas가래 = /가래/.test(agent.output().slice(-1200));
}
console.log(JSON.stringify(out, null, 1));
console.log('--- tail ---\n' + agent.tail(500));
agent.kill();
await mcp.close();
process.exit(0);
