// 실험 06(bypass): --dangerously-skip-permissions 로 띄울 때 뜨는 창과, 승인 없이 외부 명령이 실행되는지.
import { makeTempRepo, runAgent, passStartup, sleep } from './lib/harness.mjs';
const repo = makeTempRepo();
const agent = runAgent({ name: '06-claude-bypass', command: 'claude', args: ['--dangerously-skip-permissions'], cwd: repo });
await agent.settle(2500, 20000);
console.log('--- first screen ---\n' + agent.tail(700));
const first = agent.tail(700);
if (/Bypass Permissions|Yes, I accept/i.test(first)) {
  console.log('RESULT bypass 경고 창이 뜬다 (자동 통과 안 함)');
} else {
  await passStartup(agent);
  await agent.submit('Bash 로 `curl -s -m 5 https://example.com -o /dev/null -w "CODE:%{http_code}"` 를 실행하고 출력만 보여줘.');
  const ok = await agent.waitFor((o) => /CODE:200/.test(o.slice(-3000)), 90000, 'curl result');
  const asked = /Do you want to proceed/.test(agent.output());
  console.log('RESULT', JSON.stringify({ ranWithoutPrompt: ok && !asked, asked }));
  console.log(agent.tail(300));
}
agent.kill();
process.exit(0);
