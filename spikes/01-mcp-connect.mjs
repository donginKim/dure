// 실험 01: 실행 인자만으로 MCP 서버를 붙일 수 있는가.  usage: pnpm spike spikes/01-mcp-connect.mjs claude|codex [variant]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEchoMcp } from './lib/echo-mcp.mjs';
import { makeTempRepo, makeTempDir, runAgent, passStartup, gitStatus, sleep } from './lib/harness.mjs';

const [kind, variant = 'default'] = process.argv.slice(2);
const mcp = await startEchoMcp();
const repo = makeTempRepo();
const cfgDir = makeTempDir('dure-spike-cfg-');
let command, args, env = {};

if (kind === 'claude') {
  const cfg = join(cfgDir, 'mcp.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { dure: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }));
  command = 'claude';
  args = ['--mcp-config', cfg];
  if (variant !== 'nostrict') args.push('--strict-mcp-config');
  if (variant !== 'noallow') args.push('--allowedTools', 'mcp__dure');
} else {
  command = 'codex';
  env.DURE_MCP_TOKEN = mcp.token;
  args = ['-c', `mcp_servers.dure.url="${mcp.url}"`, '-c', 'mcp_servers.dure.bearer_token_env_var="DURE_MCP_TOKEN"'];
}

const agent = runAgent({ name: `01-${kind}-${variant}`, command, args, env, cwd: repo });
let pressed = await passStartup(agent);
await sleep(6000); // 늦게 뜨는 안내 창 대비
pressed += await passStartup(agent);
console.log(`startup prompts passed: ${pressed}`);
console.log('--- screen after startup ---\n' + agent.tail(500));
await agent.submit("dure_ping 도구를 note='hello' 로 호출해. 다른 건 하지 마.");
const ok = await agent.waitFor(() => mcp.calls.some((c) => c.tool === 'dure_ping'), 90000, 'dure_ping call');
await sleep(3000);
console.log('--- screen at end ---\n' + agent.tail(700));
console.log('RESULT', JSON.stringify({ kind, variant, ok, calls: mcp.calls, http: mcp.http.length, repoStatus: gitStatus(repo), args }, null, 1));
agent.kill();
await mcp.close();
process.exit(0);
