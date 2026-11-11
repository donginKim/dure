// 실험 14b: /compact 와 /clear 때 기록 경로·세션 id·기록 줄이 어떻게 바뀌는가.
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { makeTempRepo, makeTempDir, runAgent, passStartup, sleep } from './lib/harness.mjs';

const OUT = resolve(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const signals = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
  let parsed = null; try { parsed = JSON.parse(body); } catch {}
  signals.push({ name, at: Date.now(), body: parsed ?? body });
  res.writeHead(200).end('');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const signalUrl = `http://127.0.0.1:${server.address().port}/signal`;
const count = (n) => signals.filter((s) => s.name === n).length;
const repo = makeTempRepo();
const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "${signalUrl}?name=$1" 2>/dev/null\nexit 0\n`);
chmodSync(hook, 0o755);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact'];
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${e}` }] }]])) }));
const agent = runAgent({ name: '14b-compact-clear', command: 'claude', cwd: repo, args: ['--settings', settings, '한 단어로 "처음" 이라고만 답해.'] });
const starts = () => signals.filter((s) => s.name === 'SessionStart').map((s) => ({ source: s.body?.source, session: s.body?.session_id?.slice(0, 8), file: basename(s.body?.transcript_path ?? '').slice(0, 8) }));
const waitStop = async (n, label) => { const ok = await agent.waitFor(() => count('Stop') >= n, 120000, label); await sleep(1500); return ok; };
function finish(code) {
  const paths = [...new Set(signals.map((s) => s.body?.transcript_path).filter(Boolean))];
  paths.forEach((p, i) => { if (existsSync(p)) copyFileSync(p, join(OUT, `14b-transcript-${i}.jsonl`)); });
  console.log(JSON.stringify({ starts: starts(), paths: paths.map((p) => basename(p)), hooks: signals.map((s) => `${s.name}:${basename(s.body?.transcript_path ?? '').slice(0, 8)}`) }, null, 1));
  agent.kill(); server.close(); process.exit(code);
}
async function slash(cmd) {
  agent.write(cmd); await sleep(1500);
  const t = agent.tail(500);
  if (!t.includes(cmd)) { console.log('입력칸에 명령이 보이지 않음:', t); finish(1); }
  agent.write('\r');
}
try {
  await passStartup(agent);
  if (!(await waitStop(1, 'first'))) { console.log(agent.tail(500)); finish(1); }
  const s0 = count('SessionStart');
  await slash('/compact');
  console.log('compact:', await agent.waitFor(() => count('SessionStart') > s0, 180000, 'compact'));
  await agent.settle(4000, 30000);
  await agent.submit('한 단어로 "압축후" 라고만 답해.');
  await waitStop(2, 'after compact');
  const s1 = count('SessionStart');
  await slash('/clear');
  console.log('clear:', await agent.waitFor(() => count('SessionStart') > s1, 60000, 'clear'));
  await agent.settle(3000, 20000);
  await agent.submit('한 단어로 "비운후" 라고만 답해.');
  await waitStop(3, 'after clear');
  finish(0);
} catch (e) { console.log('error', String(e?.message ?? e)); finish(1); }
