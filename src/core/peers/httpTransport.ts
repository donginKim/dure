import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { PeerTransport } from './peerService';

const MAX_BODY = 512 * 1024;
const REQUEST_MS = 8000;
/** 한 주소가 1분에 보낼 수 있는 요청 수 */
const RATE_PER_MIN = 240;
const PATHS = new Set(['hello', 'pair', 'msg']);

/**
 * 다른 두레와 HTTP 로 주고받는다. 같은 네트워크의 다른 PC 가 들어올 수 있게 모든 주소에서 듣는다.
 * 내용의 보호는 여기가 아니라 PeerService 가 한다 (암호화, 보낸 사람 확인). 여기서는 크기와 빈도만 막는다.
 * - JSON 을 담은 POST 만 받는다: 웹 페이지가 사용자의 브라우저를 시켜 이 포트로 요청을 보내는 것을 막는다
 *   (브라우저는 이런 요청을 보내기 전에 허락을 묻는데, 여기서는 허락하지 않는다).
 */
export function createHttpTransport(): PeerTransport {
  let server: Server | undefined;
  const hits = new Map<string, number[]>();

  const read = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };

  return {
    async listen(port, handle) {
      const s = createServer((req, res) => {
        void (async () => {
          const host = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
          const now = Date.now();
          const recent = (hits.get(host) ?? []).filter((t) => now - t < 60_000);
          if (recent.length >= RATE_PER_MIN) { reply(res, 429, { ok: false, error: 'too many requests' }); return; }
          hits.set(host, [...recent, now]);
          if (hits.size > 500) for (const [k, v] of hits) if (v.every((t) => now - t >= 60_000)) hits.delete(k);
          const path = /^\/dure\/([a-z]+)$/.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
          if (req.method !== 'POST' || !path || !PATHS.has(path)) { reply(res, 404, { ok: false, error: 'not found' }); return; }
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { reply(res, 415, { ok: false, error: 'json only' }); return; }
          // 웹 페이지에서 온 요청은 받지 않는다.
          if (req.headers.origin !== undefined) { reply(res, 403, { ok: false, error: 'forbidden' }); return; }
          try {
            reply(res, 200, await handle(path, await read(req), host));
          } catch (e) {
            reply(res, 400, { ok: false, error: e instanceof Error ? e.message : 'error' });
          }
        })();
      });
      s.requestTimeout = 15_000;
      s.headersTimeout = 10_000;
      s.maxConnections = 64;
      await new Promise<void>((resolve, reject) => {
        s.once('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'EADDRINUSE' ? `포트 ${port} 를 다른 프로그램이 쓰고 있습니다. 설정에서 다른 포트를 고르세요.` : e.message)));
        s.listen(port, '0.0.0.0', () => resolve());
      });
      server = s;
      const at = s.address();
      return typeof at === 'object' && at ? at.port : port;
    },
    async close() {
      const s = server;
      server = undefined;
      if (!s) return;
      await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
    },
    async request(address, path, body) {
      const res = await fetch(`http://${address}/dure/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_MS), redirect: 'error',
      });
      const text = await res.text();
      if (text.length > MAX_BODY) throw new Error('too large');
      return JSON.parse(text) as unknown;
    },
  };
}
