import { diffLineKind, normalizeUrl, recallUrl, rememberUrl } from '../../src/renderer/browserView';

test('normalizeUrl: 로컬은 http, 그 밖은 https 를 붙인다', () => {
  expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
  expect(normalizeUrl(' 127.0.0.1:5173/app ')).toBe('http://127.0.0.1:5173/app');
  expect(normalizeUrl('192.168.0.10:8080')).toBe('http://192.168.0.10:8080/');
  expect(normalizeUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
  expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
  expect(normalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x');
  expect(normalizeUrl('myhost:8080/x')).toBe('https://myhost:8080/x');
});

test('normalizeUrl: http, https 가 아닌 것과 주소가 아닌 것은 열지 않는다', () => {
  for (const bad of ['', '  ', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings', 'about:blank', 'hello world', 'ftp://example.com', 'vbscript:x']) {
    expect(normalizeUrl(bad)).toBeNull();
  }
});

test('주소를 워크스페이스마다 기억한다. 이상한 값이 저장돼 있으면 쓰지 않는다', () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  expect(recallUrl('w1', storage)).toBe('');
  rememberUrl('w1', 'http://localhost:3000/', storage);
  expect(recallUrl('w1', storage)).toBe('http://localhost:3000/');
  expect(recallUrl('w2', storage)).toBe('');
  m.set('dure.browser.w3', 'javascript:alert(1)');
  expect(recallUrl('w3', storage)).toBe('');
  expect(recallUrl('w1', undefined)).toBe('');
});

test('diffLineKind', () => {
  expect(['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', ' same', '+added', '-removed', '\\ No newline at end of file', 'Binary files a/x and b/x differ'].map(diffLineKind))
    .toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'add', 'del', 'meta', 'meta']);
});
