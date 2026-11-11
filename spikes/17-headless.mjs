// 실험 17(헤드리스): 터미널 화면 없이 Claude Code 를 구조화된 입출력으로 돌릴 수 있는가.
//  Orca 의 채팅이 쓰는 방식: claude --output-format stream-json --input-format stream-json --permission-prompt-tool=stdio …
//  확인: 시작 정보(슬래시 명령 목록), 글이 조각으로 흐르는가, 승인 요청이 이벤트로 오는가, 두레의 hook 과 MCP 설정이 그대로 먹는가, 신뢰 창이 있는가
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanEnv, makeTempRepo, makeTempDir, sleep } from './lib/harness.mjs';
import { startEchoMcp } from './lib/echo-mcp.mjs';

const mcp = await startEchoMcp();
const hooks = [];
const hookServer = createServer(async (req, res) => { let b = ''; for await (const c of req) b += c; hooks.push(new URL(req.url, 'http://x').searchParams.get('name')); res.writeHead(200).end(''); });
await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
const repo = makeTempRepo(); const cfg = makeTempDir('dure-spike-cfg-');
const hook = join(cfg, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\ncurl -s -m 3 -X POST --data-binary @- "http://127.0.0.1:${hookServer.address().port}/?name=$1" 2>/dev/null\nexit 0\n`); chmodSync(hook, 0o755);
const settings = join(cfg, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command: `'${hook}' ${e}` }] }]])) }));
const mcpJson = join(cfg, 'mcp.json');
writeFileSync(mcpJson, JSON.stringify({ mcpServers: { dure: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }));

const child = spawn('claude', ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits', '--settings', settings, '--mcp-config', mcpJson, '--allowedTools', 'mcp__dure'],
  { cwd: repo, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
const events = []; let buf = ''; let err = '';
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { try { events.push({ at: Date.now(), ...JSON.parse(line) }); } catch { events.push({ raw: line.slice(0, 200) }); } } } });
child.stderr.on('data', (d) => { err += d; });
let exited = null; child.on('exit', (c) => { exited = c; });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const say = (text) => send({ type: 'user', message: { role: 'user', content: text } });
const waitFor = async (pred, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; if (exited !== null) return false; await sleep(200); } console.log('[timeout]', label); return false; };
const results = () => events.filter((e) => e.type === 'result').length;

say('dure_ping 도구를 note "hello" 로 호출하고, 그 다음 Bash 로 `curl -s -m 5 https://example.com -o /dev/null -w "%{http_code}"` 를 실행해서 결과 숫자를 말해.');
// 승인 요청이 오면 허용한다
let answered = 0;
const t = setInterval(() => {
  for (const e of events) {
    if (e.type === 'control_request' && !e._done) {
      e._done = true; answered++;
      send({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: { behavior: 'allow', updatedInput: e.request?.input ?? {} } } });
    }
  }
}, 200);
await waitFor(() => results() >= 1, 120000, 'result 1');
const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
const deltas = events.filter((e) => e.type === 'stream_event' && e.event?.type === 'content_block_delta');
const req = events.find((e) => e.type === 'control_request');
const types = {}; for (const e of events) { const k = e.type + (e.subtype ? '/' + e.subtype : '') + (e.type === 'stream_event' ? ':' + e.event?.type : ''); types[k] = (types[k] ?? 0) + 1; }
console.log(JSON.stringify({
  exited, stderr: err.slice(0, 300),
  eventTypes: types,
  init: init && { keys: Object.keys(init), slash: (init.slash_commands ?? []).slice(0, 25), slashCount: init.slash_commands?.length, mcp: init.mcp_servers, permissionMode: init.permissionMode, session: Boolean(init.session_id), model: init.model },
  textDeltas: deltas.length, firstDeltas: deltas.slice(0, 4).map((d) => d.event.delta?.text ?? d.event.delta?.partial_json ?? d.event.delta?.type),
  controlRequest: req && { subtype: req.request?.subtype, tool: req.request?.tool_name, input: req.request?.input, keys: Object.keys(req.request ?? {}) },
  answered, mcpCalls: mcp.calls.map((c) => c.args), hooks,
  result: events.filter((e) => e.type === 'result').map((r) => ({ subtype: r.subtype, text: (r.result ?? '').slice(0, 80), turns: r.num_turns })),
}, null, 1));
writeFileSync(resolve(import.meta.dirname, 'out/17-events.json'), JSON.stringify(events.map(({ _done, ...e }) => e), null, 1));

// 둘째 차례: 같은 프로세스에 이어서 보낼 수 있는가
say('한 단어로 "둘째" 라고만 답해.');
await waitFor(() => results() >= 2, 60000, 'result 2');
console.log('second:', JSON.stringify(events.filter((e) => e.type === 'result').slice(1).map((r) => r.result)));
clearInterval(t); child.stdin.end(); await sleep(1500); child.kill(); hookServer.close(); await mcp.close(); process.exit(0);
