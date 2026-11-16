import { FeedReader, parseFeed, privateAddress, publicHttps } from '@core/feeds';

test('publicHttps: https 의 바깥 주소만', () => {
  expect(publicHttps('https://feeds.bbci.co.uk/news/world/rss.xml')).toBe(true);
  for (const bad of ['http://example.com/rss', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://intranet/x', 'https://db.internal/x', 'https://user:pw@example.com/x', 'file:///etc/passwd', 'nope']) expect(publicHttps(bad)).toBe(false);
});

test('parseFeed: RSS 와 Atom 에서 제목·링크·때를 읽고, 꾸밈과 태그는 걷어 낸다', () => {
  const rss = `<rss><channel><title>채널</title>
    <item><title><![CDATA[[속보] 첫째 &amp; 둘째]]></title><link>https://a.example.com/1?x=1&amp;y=2</link><pubDate>Mon, 16 Nov 2026 09:00:00 +0900</pubDate></item>
    <item><title>&lt;b&gt;굵게&lt;/b&gt; <script>alert(1)</script>보통</title><link>javascript:alert(1)</link></item>
    <item><title></title><link>https://a.example.com/3</link></item></channel></rss>`;
  const items = parseFeed(rss);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ title: '[속보] 첫째 & 둘째', link: 'https://a.example.com/1?x=1&y=2' });
  expect(items[0]!.at).toBe(Date.parse('2026-11-16T00:00:00Z'));
  expect(items[1]).toMatchObject({ title: '<b>굵게</b> alert(1)보통', link: '' });
  const atom = '<feed><entry><title>아톰 글</title><link rel="alternate" href="https://b.example.com/p"/><updated>2026-11-16T01:02:03Z</updated></entry></feed>';
  expect(parseFeed(atom)).toEqual([{ title: '아톰 글', link: 'https://b.example.com/p', at: Date.parse('2026-11-16T01:02:03Z') }]);
});

test('FeedReader: 받아 둔 것을 다시 쓰고, 안쪽 주소는 읽지 않고, 실패하면 앞의 것을 보인다', async () => {
  let calls = 0; let fail = false;
  const r = new FeedReader(async (url) => { calls++; if (fail) throw new Error('끊김'); return { ok: true, status: 200, url, text: async () => '<rss><item><title>하나</title><link>https://x.example.com/1</link></item></rss>' }; });
  expect((await r.read('https://x.example.com/rss')).items).toHaveLength(1);
  await r.read('https://x.example.com/rss');
  expect(calls).toBe(1);
  expect((await r.read('https://localhost/rss')).error).toContain('읽을 수 없는 주소');
  expect(calls).toBe(1);
  fail = true;
  const again = await r.read('https://x.example.com/rss', true);
  expect(again.error).toBe('끊김');
  expect(again.items).toHaveLength(1);
  // 안쪽 주소로 넘겨지면 받지 않는다
  const redirect = new FeedReader(async () => ({ ok: true, status: 200, url: 'https://127.0.0.1/secret', text: async () => '<rss><item><title>비밀</title></item></rss>' }));
  expect(await redirect.read('https://y.example.com/rss')).toMatchObject({ items: [], error: '다른 주소로 넘겨졌습니다.' });
});

test('publicHttps: 끝점·안쪽 이름도 받지 않는다', () => {
  for (const bad of ['https://localhost./x', 'https://printer.local./x', 'https://metadata.google.internal./x', 'https://foo.localhost/x', 'https://router.home/x']) expect(publicHttps(bad)).toBe(false);
});

test('privateAddress: 사설·이 PC·링크로컬 주소', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(privateAddress(ip)).toBe(true);
  for (const ip of ['8.8.8.8', '151.101.0.81', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false);
});

test('parseFeed: 나쁜 피드가 앱을 붙잡지 못한다 (큰 입력도 금방 끝난다)', () => {
  const t0 = Date.now();
  expect(parseFeed(`<rss><item><title>${'<'.repeat(1_400_000)}</title></item></rss>`)).toEqual([]);
  expect(parseFeed('<![CDATA['.repeat(160_000))).toEqual([]);
  expect(parseFeed('<item>'.repeat(240_000))).toEqual([]);
  expect(parseFeed(`<rss>${'<item><title>'.repeat(100_000)}</rss>`)).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(2000);
  // 범위를 넘는 문자 번호는 버린다 (피드 전체가 깨지지 않는다)
  expect(parseFeed('<rss><item><title>가&#99999999;나&#44032;</title></item></rss>')[0]!.title).toBe('가나가');
});

test('parseFeed: 소문자로 바꾸면 길이가 달라지는 글자가 있어도 자리가 어긋나지 않는다', () => {
  const xml = `<rss>${Array.from({ length: 5 }, (_, i) => `<item><title>İstanbul İİİ ${i}</title><link>https://t.example.com/${i}</link></item>`).join('')}</rss>`;
  expect(parseFeed(xml).map((x) => x.link)).toEqual([0, 1, 2, 3, 4].map((i) => `https://t.example.com/${i}`));
});
