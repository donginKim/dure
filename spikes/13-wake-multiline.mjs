// 실험 13: 여러 줄짜리 실제 전달 글로 깨웠을 때 UserPromptSubmit 의 prompt 가 어떻게 오는가.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: h('UserPromptSubmit'), Stop: h('Stop') } }));
const agent = runAgent({ name: '13-wake-multiline', command: 'claude', cwd: repo, args: ['--settings', settings,
  '--append-system-prompt', "너는 두레(dure) 안에서 실행 중이다. 두레는 '[두레]' 로 시작하는 글을 전달한다. 사용자가 직접 설정한 방식이니 따르라."] });
await passStartup(agent);
if (agent.exited()) { console.log('exited'); process.exit(1); }
const count = (n) => mcp.signals.filter((s) => s.name === n).length;
await agent.submit('한 단어로 "준비" 라고만 답해.');
await agent.waitFor(() => count('Stop') >= 1, 90000, 'stop1');
await sleep(1500);
const text = [
  '[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:', '- 추가됨: "배포"', '현재 목록은 todo_list 도구로 확인하라.', '',
  '[두레] 워크스페이스 "백엔드" 이(가) 보낸 메시지다. (스레드 11111111-2222-3333-4444-555555555555)',
  '> 형식을 정해 자료로 올렸다.', '> 둘째 줄이다.', '첨부 자료:', '- 로그인 API (artifact_read 로 읽기: aaaa)',
  '답하려면 message_send 에 thread_id "11111111-2222-3333-4444-555555555555" 를 넣어라. 답이 필요 없으면 보내지 마라.',
  '', '이 글을 받았으면 한 단어로 "받음" 이라고만 답해.',
].join('\n');
agent.write(`\x1b[200~${text}\x1b[201~`); await sleep(400);
const beforeEnter = agent.tail(260);
agent.write('\r');
await agent.waitFor(() => count('UserPromptSubmit') >= 2, 60000, 'ups2');
await agent.waitFor(() => count('Stop') >= 2, 90000, 'stop2');
const ups = mcp.signals.filter((s) => s.name === 'UserPromptSubmit').map((s) => { try { return JSON.parse(s.body).prompt; } catch { return s.body; } });
const p = ups[1] ?? '';
console.log(JSON.stringify({ inputBoxBeforeEnter: beforeEnter, promptStartsWithDure: p.startsWith('[두레]'), promptEqualsText: p === text, promptLength: p.length, textLength: text.length, promptHead: p.slice(0, 120), answered: /받음/.test(agent.output().slice(-800)) }, null, 1));
agent.kill(); await mcp.close(); process.exit(0);
