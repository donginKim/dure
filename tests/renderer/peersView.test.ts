import { normalizeAddress, remoteName, setRemoteNames, spokenCode, statusLine } from '../../src/renderer/peersView';
import { workspaceName } from '../../src/renderer/conversationView';

test('statusLine: 꺼짐, 오류, 켜짐', () => {
  const base = { id: 'x', name: '가', fingerprint: 'abcd1234', port: null as number | null };
  expect(statusLine({ ...base, enabled: false })).toContain('꺼져 있습니다');
  expect(statusLine({ ...base, enabled: true, error: '포트 사용 중' })).toBe('켜지 못했습니다: 포트 사용 중');
  expect(statusLine({ ...base, enabled: true, port: 47800 })).toBe('켜져 있습니다 · 포트 47800 · 내 이름 "가" · 열쇠 지문 abcd1234');
  expect(spokenCode('123456')).toBe('123 456');
});

test('normalizeAddress: 포트를 안 적으면 기본 포트. 주소가 아니면 null', () => {
  expect(normalizeAddress('192.168.0.12')).toBe('192.168.0.12:47800');
  expect(normalizeAddress(' 192.168.0.12:5000 ')).toBe('192.168.0.12:5000');
  expect(normalizeAddress('http://mac-mini.local:47800/x')).toBe('mac-mini.local:47800');
  for (const bad of ['', 'a b', '192.168.0.12:99999', 'x:0', 'a@b:1', '::1']) expect(normalizeAddress(bad)).toBeNull();
});

test('다른 사람의 워크스페이스는 "워크스페이스@사람" 으로 보인다', () => {
  setRemoteNames({ 'remote:p1:w1': '화면@나' });
  expect(remoteName('remote:p1:w1')).toBe('화면@나');
  expect(remoteName('remote:p1:other')).toBe('다른 사람의 워크스페이스');
  expect(remoteName('local-id')).toBeUndefined();
  expect(workspaceName('remote:p1:w1', [])).toBe('화면@나');
  setRemoteNames({});
});
