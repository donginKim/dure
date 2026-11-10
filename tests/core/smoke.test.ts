import Database from 'better-sqlite3';
import * as pty from 'node-pty';

test('네이티브 모듈이 테스트 런타임에서 로드된다', () => {
  const db = new Database(':memory:');
  expect(db.prepare('select 1 as n').get()).toEqual({ n: 1 });
  expect(typeof pty.spawn).toBe('function');
});
