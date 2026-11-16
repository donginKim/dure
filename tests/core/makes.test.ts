import { openDatabase } from '@core/db';
import { MakeService, MAKE_CSP, sealHtml, type MakeRunner } from '@core/makes';

const DOC = '<!doctype html><html><head><title>쇼핑몰 &amp; 주간 보고</title></head><body><h1>보고</h1></body></html>';

function setup(o: { runner?: MakeRunner; materials?: string; blocked?: string | null } = {}) {
  const db = openDatabase(':memory:');
  const prompts: string[] = []; const used: number[] = [];
  const runner: MakeRunner = o.runner ?? (async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: `여기 있습니다.\n\`\`\`html\n${DOC}\n\`\`\``, usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, model: 'm' } }; });
  const svc = new MakeService({
    db, env: {}, runner, cwd: '/tmp', executable: () => '', model: () => 'm',
    projectName: (id) => (id === 'p1' ? '쇼핑몰' : null),
    materials: async () => o.materials ?? '[할 일] 완료 1\n- (완료) 결제 API',
    pluginKinds: () => [{ id: 'plugin:corp:0', name: '주간 보고', plugin: '회사 양식', prompt: '세 줄 요약을 맨 위에', format: 'report' }],
    blocked: () => o.blocked ?? null,
    onUsage: (_p, u) => { used.push(u.input + u.output); },
  });
  const settle = (): Promise<void> => new Promise((r) => { svc.once('changed', () => setTimeout(r, 0)); });
  return { db, svc, prompts, used, settle };
}

test('sealHtml: 문서만 꺼내고, 바깥과 주고받지 못하게 하는 규칙을 박는다', () => {
  const s = sealHtml(`설명\n${DOC}\n끝`)!;
  expect(s.html.startsWith('<!doctype html>')).toBe(true);
  expect(s.html.endsWith('</html>')).toBe(true);
  expect(s.html.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAKE_CSP}"><html>`)).toBe(true);
  // 가짜 <head> 나 앞선 스크립트로 규칙을 비켜 가지 못한다: 규칙은 늘 맨 앞에 온다
  for (const trick of ['<!doctype html><!--<head>--><script>x()</script><html><body>가</body></html>', '<html><script>x()</script><header>가</header></html>']) {
    const t = sealHtml(trick)!.html;
    expect(t.indexOf('Content-Security-Policy')).toBeLessThan(t.indexOf('<script>'));
    expect(t.indexOf('Content-Security-Policy')).toBeLessThan(t.indexOf('<!--') < 0 ? Infinity : t.indexOf('<!--'));
  }
  expect(s.title).toBe('쇼핑몰 & 주간 보고');
  expect(sealHtml('<html><body>머리 없음</body></html>')!.html).toContain('Content-Security-Policy');
  expect(sealHtml('문서가 아니다')).toBeNull();
  expect(sealHtml(`<html>${'가'.repeat(1_600_000)}</html>`)).toBeNull();
  expect(MAKE_CSP).toContain("default-src 'none'");
});

test('만들기: 자료와 방향을 건네 문서를 받고, 쓴 토큰을 적는다', async () => {
  const { svc, prompts, used, settle } = setup();
  expect(svc.kinds('p1').map((k) => k.id)).toEqual(['report', 'slides', 'visual', 'plugin:corp:0']);
  const done = settle();
  const m = await svc.create('p1', 'slides', '임원 보고용', '회의록: 다음 주 출시');
  expect(m).toMatchObject({ state: 'working', kindName: '발표 자료', direction: '임원 보고용' });
  await done;
  const after = svc.list('p1')[0]!;
  expect(after).toMatchObject({ state: 'done', title: '쇼핑몰 & 주간 보고', tokens: 150 });
  expect(svc.html(after.id)).toContain('Content-Security-Policy');
  expect(used).toEqual([150]);
  expect(prompts[0]).toContain('결제 API');
  expect(prompts[0]).toContain('임원 보고용');
  expect(prompts[0]).toContain('회의록: 다음 주 출시');
  expect(prompts[0]).toContain('한 화면에 한 장');
  // 자료 표에는 이번에만 쓰는 번호가 붙는다 (자료 안의 글이 표를 흉내 내지 못하게)
  expect(prompts[0]).toMatch(/\[자료 [0-9a-f]{8} — 끝\]/);
  expect(prompts[0]).not.toContain('[자료 — 끝]');
  expect(after.size).toBe(svc.html(after.id)!.length);
  svc.remove(after.id);
  expect(svc.list('p1')).toEqual([]);
});

test('만들기: 플러그인 양식의 주문을 덧붙인다', async () => {
  const { svc, prompts, settle } = setup();
  const done = settle();
  await svc.create('p1', 'plugin:corp:0');
  await done;
  expect(prompts[0]).toContain('세 줄 요약을 맨 위에');
  expect(prompts[0]).toContain('"회사 양식"');
  expect(svc.list('p1')[0]).toMatchObject({ state: 'done', kindName: '주간 보고' });
});

test('만들기: 막아야 할 때는 모델을 부르지 않는다', async () => {
  let calls = 0;
  const runner: MakeRunner = async () => { calls++; return { ok: true, text: DOC }; };
  await expect(setup({ runner }).svc.create('없음', 'report')).rejects.toThrow('프로젝트가 없습니다');
  await expect(setup({ runner }).svc.create('p1', '엉뚱')).rejects.toThrow('없는 양식');
  await expect(setup({ runner, blocked: '예산을 넘었습니다' }).svc.create('p1', 'report')).rejects.toThrow('예산');
  await expect(setup({ runner, materials: '' }).svc.create('p1', 'report')).rejects.toThrow('자료가 없습니다');
  expect(calls).toBe(0);
  // 자료가 없어도 붙여 넣은 글이 있으면 만든다
  const s = setup({ runner, materials: '' }); const done = s.settle();
  await s.svc.create('p1', 'report', '', '붙여 넣은 글');
  await done;
  expect(calls).toBe(1);
});

test('만들기: 한 프로젝트에서 한 번에 하나, 실패는 까닭과 함께 남는다', async () => {
  let release: (() => void) | undefined;
  const runner: MakeRunner = () => new Promise((r) => { release = () => r({ ok: true, text: '문서가 아닌 답' }); });
  const { svc } = setup({ runner });
  await svc.create('p1', 'report');
  await expect(svc.create('p1', 'slides')).rejects.toThrow('이미 하나를');
  const done = new Promise<void>((r) => { svc.once('changed', () => r()); });
  release!();
  await done;
  expect(svc.list('p1')[0]).toMatchObject({ state: 'failed' });
  expect(svc.list('p1')[0]!.error).toContain('문서가 아니거나');
  expect(svc.html(svc.list('p1')[0]!.id)).toBeNull();
  // 끝났으니 다시 만들 수 있다
  await expect(svc.create('p1', 'report')).resolves.toMatchObject({ state: 'working' });
});

test('만들기: 만드는 중에 앱이 꺼졌던 것은 실패로 돌린다', async () => {
  const { db, svc } = setup({ runner: () => new Promise(() => undefined) });
  await svc.create('p1', 'report');
  const again = new MakeService({ db, env: {}, runner: async () => ({ ok: true, text: DOC }), cwd: '/tmp', executable: () => '', model: () => '', projectName: () => '쇼핑몰', materials: async () => 'x', pluginKinds: () => [], blocked: () => null, onUsage: () => undefined });
  expect(again.list('p1')[0]).toMatchObject({ state: 'failed' });
});

test('플러그인의 만들기 양식: 읽고, 승인의 대상(지문)에 넣는다', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPlugin } = await import('@core/plugins');
  const dir = mkdtempSync(join(tmpdir(), 'dure-maker-'));
  const write = (makers: unknown): void => writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'kit', name: '양식', makers }));
  write([{ name: '주간 보고', prompt: '세 줄 요약', format: 'slides' }, { name: '틀 없음', prompt: 'x', format: '엉뚱' }, { name: '', prompt: 'x' }, { name: '주문 없음' }]);
  const a = readPlugin(dir);
  expect(a.plugin.makers).toEqual([{ name: '주간 보고', prompt: '세 줄 요약', format: 'slides' }, { name: '틀 없음', prompt: 'x', format: 'report' }]);
  write([{ name: '주간 보고', prompt: '바뀐 주문', format: 'slides' }]);
  expect(readPlugin(dir).hash).not.toBe(a.hash);
});
