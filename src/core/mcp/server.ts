import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Project, Workspace } from '@shared/types';
import type { CleanupService } from '../cleanup';
import type { CoordinatorService } from '../coordinator';
import type { DbService } from '../dbService';
import type { Git } from '../git';
import type { CommitDraftStore } from '../commitDrafts';
import type { DeliveryService } from '../delivery';
import type { MessageService } from '../messages';
import type { ProjectStore, RepoStore, WorkspaceStore } from '../stores';
import type { TodoService } from '../todos';

/** 요청을 보낸 에이전트가 속한 워크스페이스와 프로젝트. 토큰으로 정해진다. */
export interface McpContext {
  workspace: Workspace;
  project: Project;
}

export interface McpDeps {
  workspaces: WorkspaceStore;
  projects: ProjectStore;
  repos: RepoStore;
  todos: TodoService;
  messages: MessageService;
  delivery: DeliveryService;
  commitDrafts: CommitDraftStore;
  cleanup: CleanupService;
  coordinator: CoordinatorService;
  dbs: DbService;
  git: Git;
  /** 에이전트의 hook 호출. hook 이 표준 출력으로 내보낼 글을 돌려준다. */
  onHook(workspace: Workspace, event: string, payload: unknown): string;
}

/** 도구 묶음 하나. 뒤 단계는 묶음 파일을 더해 도구를 늘린다. */
export type ToolBundle = (server: McpServer, ctx: McpContext, deps: McpDeps) => void;

export interface RunningMcpServer {
  port: number;
  address: string;
  url: string;
  /** hook 스크립트가 부르는 주소. 뒤에 /<이벤트> 를 붙인다. */
  hookUrl: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

async function readText(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readText(req);
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
    const hook = /^\/hook\/([A-Za-z]+)$/.exec(path);
    if (path !== '/mcp' && !hook) { res.writeHead(404).end(); return; }
    const ctx = contextFor(req, deps);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized'); return; }

    if (hook) {
      // hook 은 에이전트의 동작을 막으면 안 된다. 본문이 이상해도 받아서 넘긴다.
      const raw = await readText(req);
      let payload: unknown = raw;
      try { payload = JSON.parse(raw); } catch { /* 글 그대로 넘긴다 */ }
      const body = deps.onHook(ctx.workspace, hook[1], payload);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
      return;
    }

    // 완료된 프로젝트는 기록만 본다. 그 프로젝트의 토큰으로 온 도구 호출은 받지 않는다
    // (완료 뒤에도 살아 있는 프로세스나, 작업 폴더에서 따로 띄운 에이전트).
    if (ctx.project.status === 'done') { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('완료된 프로젝트입니다.'); return; }
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
    hookUrl: `http://${HOST}:${address.port}/hook`,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}
