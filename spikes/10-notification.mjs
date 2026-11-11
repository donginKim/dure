// 실험 10: Notification hook 이 받는 본문 전체를 남긴다 (승인 요청을 가려낼 필드 확인용).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startEchoMcp } from './lib/echo-mcp.mjs';
import { makeTempRepo, makeTempDir, runAgent, passStartup, sleep } from './lib/harness.mjs';

const mcp = await startEchoMcp();
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "${mcp.signalUrl}?name=$1" >/dev/null 2>&1\nexit 0\n`);
chmodSync(hook, 0o755);
const h = (ev) => [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${ev}` }] }];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: { Notification: h('Notification'), Stop: h('Stop'), UserPromptSubmit: h('UserPromptSubmit') } }));

const agent = runAgent({ name: '10-notification', command: 'claude', args: ['--settings', settings, '--permission-mode', 'acceptEdits'], cwd: repo });
await passStartup(agent);
if (agent.exited()) { console.log('exited at startup'); process.exit(1); }
await agent.submit('Bash 로 `curl -s -m 5 https://example.com -o /dev/null -w "%{http_code}"` 를 실행해.');
const count = (n) => mcp.signals.filter((s) => s.name === n).length;
await agent.waitFor(() => count('Notification') >= 1 || count('Stop') >= 1, 90000, 'notification');
await sleep(1500);
const promptShown = /Do you want to proceed|❯ 1\. Yes/.test(agent.output().slice(-3000));
// 화면에 승인 창이 떠 있는 것을 확인한 뒤에만 Esc 로 닫는다.
if (promptShown) { agent.write('\x1b'); await sleep(2500); }
// 쉬는 채로 두면 오는 "입력 대기" 알림도 받아 본다 (최대 75초)
await agent.waitFor(() => count('Notification') >= 2, 75000, 'idle notification');
const bodies = mcp.signals.filter((s) => s.name === 'Notification').map((s) => { try { return JSON.parse(s.body); } catch { return s.body; } });
const out = resolve(import.meta.dirname, 'out/notification.json');
mkdirSync(resolve(import.meta.dirname, 'out'), { recursive: true });
writeFileSync(out, JSON.stringify(bodies, null, 2));
console.log(JSON.stringify({ promptShown, notifications: bodies.map((b) => { const { transcript_path, session_id, cwd, ...rest } = b; return rest; }) }, null, 1));
agent.kill();
await mcp.close();
process.exit(0);
