import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Project, Workspace } from '@shared/types';
import type { ProjectStore, WorkspaceStore } from '../stores';

/** 요청을 보낸 에이전트가 속한 워크스페이스와 프로젝트. 토큰으로 정해진다. */
export interface McpContext {
  workspace: Workspace;
  project: Project;
}

export interface McpDeps {
  workspaces: WorkspaceStore;
  projects: ProjectStore;
}

/** 도구 묶음 하나. 뒤 단계는 묶음 파일을 더해 도구를 늘린다. */
export type ToolBundle = (server: McpServer, ctx: McpContext, deps: McpDeps) => void;

export interface RunningMcpServer {
  port: number;
  address: string;
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function contextFor(req: IncomingMessage, deps: McpDeps): McpContext | undefined {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!match) return undefined;
  const workspace = deps.workspaces.findByToken(match[1]);
  const project = workspace && deps.projects.get(workspace.projectId);
  return workspace && project ? { workspace, project } : undefined;
}

/**
 * 에이전트용 MCP 서버를 연다. localhost 에만 묶인다.
 * 요청마다 토큰으로 워크스페이스를 가려, 그 워크스페이스 문맥의 서버 인스턴스로 처리한다(상태 없는 Streamable HTTP).
 */
export async function startMcpServer(deps: McpDeps, bundles: ToolBundle[], port = 0): Promise<RunningMcpServer> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') { res.writeHead(404).end(); return; }
    const ctx = contextFor(req, deps);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized'); return; }

    const mcp = new McpServer({ name: 'dure', version: '0.1.0' });
    for (const bundle of bundles) bundle(mcp, ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, HOST, resolve);
  });
  const address = http.address() as AddressInfo;
  return {
    port: address.port,
    address: address.address,
    url: `http://${HOST}:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}
