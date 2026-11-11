// 실험 16: 슬래시 명령을 입력칸에 써 넣으면 어떤 hook 과 기록 줄이 오는가.
//  /context (출력만 내는 명령), /model (고르는 화면이 뜨는 명령)
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepo, makeTempDir, runAgent, passStartup, sleep } from './lib/harness.mjs';

const signals = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  let parsed = null; try { parsed = JSON.parse(body); } catch {}
  signals.push({ name: new URL(req.url, 'http://x').searchParams.get('name'), body: parsed });
  res.writeHead(200).end('');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/signal`;
const repo = makeTempRepo(); const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "${url}?name=$1" 2>/dev/null\nexit 0\n`); chmodSync(hook, 0o755);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${e}` }] }]])) }));
const agent = runAgent({ name: '16-slash', command: 'claude', cwd: repo, args: ['--settings', settings] });
await passStartup(agent);
await agent.waitFor(() => signals.some((s) => s.name === 'SessionStart'), 30000, 'start');
await sleep(1500);
const path = () => signals.find((s) => s.body?.transcript_path)?.body.transcript_path;
const lines = () => { const p = path(); return p && existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const brief = (r) => { const c = r.message?.content; return `${r.type}${r.subtype ? '/' + r.subtype : ''}${r.isMeta ? ' meta' : ''}: ${(typeof c === 'string' ? c : r.content ?? '').toString().slice(0, 160).replace(/\n/g, '⏎')}`; };
async function run(cmd, waitMs) {
  const h0 = signals.length; const l0 = lines().length;
  agent.write(cmd); await sleep(1500);
  if (!agent.tail(600).includes(cmd)) { console.log('입력칸에 안 보임', cmd); return; }
  agent.write('\r'); await sleep(waitMs);
  console.log(`\n=== ${cmd} ===`);
  console.log('hooks:', signals.slice(h0).map((s) => s.name).join(', ') || '(없음)');
  console.log('lines:\n ' + lines().slice(l0).filter((r) => ['user', 'system', 'assistant'].includes(r.type)).map(brief).join('\n '));
  console.log('screen:\n' + agent.tail(500));
}
await run('/context', 6000);
await run('/model', 4000);
agent.write('\x1b'); await sleep(1500); // 고르는 화면을 닫는다
console.log('\n=== Esc 뒤 ===\nhooks total:', signals.map((s) => s.name).join(', '));
console.log('lines:\n ' + lines().slice(-4).filter((r) => ['user', 'system'].includes(r.type)).map(brief).join('\n '));
console.log(agent.tail(300));
agent.kill(); server.close(); process.exit(0);
