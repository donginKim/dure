import { markMatches, noteHeading, noteTime } from '../../src/renderer/notesView';

test('목록의 시각: 오늘은 시:분, 올해는 월/일, 그 전은 연/월/일', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  expect(noteTime(new Date(2026, 10, 12, 9, 5).getTime(), now)).toBe('09:05');
  expect(noteTime(new Date(2026, 2, 4, 9, 5).getTime(), now)).toBe('3/4');
  expect(noteTime(new Date(2025, 11, 31, 9, 5).getTime(), now)).toBe('2025/12/31');
});

test('제목이 없으면 본문의 앞부분을 제목 자리에 보인다', () => {
  expect(noteHeading('배포', '본문')).toBe('배포');
  expect(noteHeading('  ', '회의: 금요일 3시')).toBe('회의: 금요일 3시');
  expect(noteHeading('', '')).toBe('새 메모');
});

test('찾은 낱말을 표시한다 (대소문자를 가리지 않고, 여러 낱말)', () => {
  expect(markMatches('Kafka 토픽 kafka', 'KAFKA')).toEqual([{ text: 'Kafka', hit: true }, { text: ' 토픽 ', hit: false }, { text: 'kafka', hit: true }]);
  expect(markMatches('배포 순서와 배포 확인', '확인 배포').filter((p) => p.hit).map((p) => p.text)).toEqual(['배포', '배포', '확인']);
  expect(markMatches('글', '')).toEqual([{ text: '글', hit: false }]);
});
