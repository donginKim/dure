import { request as rawRequest } from 'node:http';
import { createHttpTransport } from '@core/peers/httpTransport';

const post = (port: number, path: string, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }, method = 'POST'): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = rawRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t })); });
    req.on('error', reject);
    req.end(body);
  });

test('두 두레가 실제 소켓으로 주고받는다. 받는 쪽은 보낸 쪽의 주소를 안다', async () => {
  const a = createHttpTransport(); const b = createHttpTransport();
  const got: unknown[] = [];
  const port = await b.listen(0, async (path, body, host) => { got.push({ path, body, host }); return { ok: true, echo: body }; });
  try {
    expect(await a.request(`127.0.0.1:${port}`, 'msg', { hi: '안녕' })).toEqual({ ok: true, echo: { hi: '안녕' } });
    expect(got).toEqual([{ path: 'msg', body: { hi: '안녕' }, host: '127.0.0.1' }]);
    await expect(a.request('127.0.0.1:1', 'hello', {})).rejects.toThrow();
  } finally { await b.close(); await a.close(); }
  await expect(a.request(`127.0.0.1:${port}`, 'hello', {})).rejects.toThrow();
});

test('JSON 을 담은 POST 만 받는다: 다른 경로, 다른 방식, 웹 페이지에서 온 것, 큰 것, 깨진 것은 받지 않는다', async () => {
  const t = createHttpTransport();
  let called = 0;
  const port = await t.listen(0, async () => { called++; return { ok: true }; });
  try {
    expect((await post(port, '/dure/msg', '{}')).status).toBe(200);
    expect((await post(port, '/dure/other', '{}')).status).toBe(404);
    expect((await post(port, '/', '{}')).status).toBe(404);
    expect((await post(port, '/dure/msg', '', {}, 'GET')).status).toBe(404);
    expect((await post(port, '/dure/msg', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post(port, '/dure/msg', '{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(port, '/dure/msg', '{}', { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(port, '/dure/msg', '{not json')).status).toBe(400);
    const big = await post(port, '/dure/msg', JSON.stringify({ x: 'y'.repeat(600_000) })).catch(() => ({ status: 0, text: '' }));
    expect(big.status).not.toBe(200);
    expect(called).toBe(1);
  } finally { await t.close(); }
});

test('포트를 다른 프로그램이 쓰고 있으면 이유를 알려 준다', async () => {
  const a = createHttpTransport(); const b = createHttpTransport();
  const port = await a.listen(0, async () => ({}));
  try {
    await expect(b.listen(port, async () => ({}))).rejects.toThrow('다른 프로그램이 쓰고 있습니다');
  } finally { await a.close(); }
});
