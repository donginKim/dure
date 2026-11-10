// 실험용 MCP 서버: dure_ping 도구 하나, Bearer 토큰 검사, 호출 기록.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function startEchoMcp() {
  const token = randomBytes(16).toString('hex');
  const calls = [];
  const signals = [];
  const http = [];
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    http.push({ method: req.method, url: req.url, auth: auth ? 'present' : 'none' });
    if (req.url?.startsWith('/signal')) {
      // hook 등에서 상태 신호를 찍는 용도: POST /signal?name=...
      let body = '';
      for await (const c of req) body += c;
      const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
      signals.push({ name, at: Date.now(), body });
      res.writeHead(200).end('ok');
      return;
    }
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (auth !== `Bearer ${token}`) { res.writeHead(401).end('unauthorized'); return; }
    const mcp = new McpServer({ name: 'dure', version: '0.0.0' });
    mcp.registerTool(
      'dure_ping',
      { description: 'Dure connectivity check. Records the note.', inputSchema: { note: z.string() } },
      async ({ note }) => {
        calls.push({ tool: 'dure_ping', args: { note }, auth: 'ok', at: Date.now() });
        return { content: [{ type: 'text', text: `pong:${note}` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    let raw = '';
    for await (const c of req) raw += c;
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    signalUrl: `http://127.0.0.1:${port}/signal`,
    token, calls, signals, http,
    close: () => new Promise((r) => server.close(r)),
  };
}
