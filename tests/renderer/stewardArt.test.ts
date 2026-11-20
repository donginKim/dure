import { stewardMood } from '../../src/renderer/stewardArt';

vi.mock('../../src/renderer/assets/steward.png', () => ({ default: 'idle.png' }));
vi.mock('../../src/renderer/assets/steward-work.png', () => ({ default: 'work.png' }));
vi.mock('../../src/renderer/assets/steward-wait.png', () => ({ default: 'wait.png' }));
vi.mock('../../src/renderer/assets/steward-rest.png', () => ({ default: 'rest.png' }));
vi.mock('../../src/renderer/assets/steward-face.png', () => ({ default: 'idle-face.png' }));
vi.mock('../../src/renderer/assets/steward-face-work.png', () => ({ default: 'work-face.png' }));
vi.mock('../../src/renderer/assets/steward-face-wait.png', () => ({ default: 'wait-face.png' }));
vi.mock('../../src/renderer/assets/steward-face-rest.png', () => ({ default: 'rest-face.png' }));

test('비서의 모습은 에이전트의 상태를 따른다: 꺼져 있으면 쉬고, 일하면 적고, 내 답을 기다리면 손을 든다', () => {
  expect(stewardMood('working')).toBe('work');
  expect(stewardMood('waiting_user')).toBe('wait');
  expect(stewardMood('stopped')).toBe('rest');
  expect(stewardMood(undefined)).toBe('rest');
  expect(stewardMood('idle')).toBe('idle');
});
