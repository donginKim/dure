import { openDatabase } from '@core/db';
import { MemoryStore } from '@core/memory';

test('프로젝트 기억: 한 줄로 남기고, 같은 글은 다시 적지 않고, 새 대화에 건넬 간추림은 글자 수 상한을 지킨다', () => {
  const m = new MemoryStore(openDatabase(':memory:'));
  expect(() => m.add('p1', { text: '  ', author: 'x' })).toThrow('적을 내용');
  const a = m.add('p1', { kind: 'decision', text: '결제는 토스만 붙인다\n카카오페이는 다음 분기', author: '조율 에이전트' });
  expect(a.text).toBe('결제는 토스만 붙인다 카카오페이는 다음 분기');
  expect(m.add('p1', { kind: 'decision', text: '결제는 토스만 붙인다 카카오페이는 다음 분기', author: 'API' }).id).toBe(a.id);
  m.add('p1', { kind: 'command', text: 'pnpm test -- --run', author: 'API' });
  m.add('p1', { kind: 'nope', text: '목 서버는 포트 4010', author: 'API' });
  m.add('p2', { text: '다른 프로젝트', author: 'x' });
  expect(m.list('p1').map((x) => x.kind).sort()).toEqual(['command', 'decision', 'lesson']);
  const d = m.digest('p1');
  expect(d).toContain('- [정한 것] 결제는 토스만 붙인다');
  expect(d).toContain('- [명령] pnpm test -- --run');
  expect(d).not.toContain('다른 프로젝트');
  expect(m.digest('p1', 30).split('\n').length).toBeLessThanOrEqual(1);
  m.remove(a.id);
  expect(m.list('p1')).toHaveLength(2);
});
