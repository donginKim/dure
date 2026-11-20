import { trayState } from '@core/trayState';
import type { AttentionItem, DailyDigest, Project, Workspace } from '@shared/types';

const project = (id: string, name: string, status = 'active'): Project => ({ id, name, status } as unknown as Project);
const ws = (id: string, name: string, status: string, role = 'worker', summary = ''): Workspace => ({ id, name, status, role, summary } as unknown as Workspace);
const item = (id: string, title: string): AttentionItem => ({ id, kind: 'agent', projectId: 'p1', projectName: '쇼핑몰', workspaceId: null, title, detail: '' });
const digest = (done = 0, commits = 0): DailyDigest => ({ day: '2026-11-20', projects: [], totals: { done, commits, mains: 1, tokens: 0, workMs: 3_600_000 }, doing: [], todo: 0, attention: [] });
const base = {
  stewardName: '비서', attention: (): AttentionItem[] => [], projects: () => [project('p1', '쇼핑몰')], workspaces: (): Workspace[] => [],
  doing: () => '', digest: () => digest(), grass: (n: number) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, todos: 0, commits: 0, mains: 0, score: 0 })),
};

test('기다리는 것이 있으면 wait, 일하는 에이전트만 있으면 work, 아니면 rest', () => {
  expect(trayState(base).mood).toBe('rest');
  expect(trayState({ ...base, workspaces: () => [ws('w1', '화면', 'working')] }).mood).toBe('work');
  expect(trayState({ ...base, workspaces: () => [ws('w1', '화면', 'working')], attention: () => [item('a', '권한 요청')] }).mood).toBe('wait');
});

test('일하는 중이거나 내 답을 기다리는 워크스페이스만 든다. 내 답을 기다리는 것이 앞에 온다', () => {
  const st = trayState({
    ...base,
    projects: () => [project('p1', '쇼핑몰'), project('p2', '끝난 것', 'done')],
    workspaces: (id) => (id === 'p1' ? [ws('w1', '화면', 'working', 'worker', '요약'), ws('w2', '서버', 'idle'), ws('w3', 'x', 'waiting_user', 'coordinator')] : [ws('w9', '옛것', 'working')]),
    doing: (id) => (id === 'w1' ? 'Bash: npm test' : ''),
  });
  expect(st.agents.map((a) => `${a.name}:${a.status}:${a.doing}`)).toEqual(['조율 에이전트:waiting_user:', '화면:working:Bash: npm test']);
});

test('확인할 것은 앞의 8건과 전체 수, 오늘의 수와 최근 12주의 잔디', () => {
  const st = trayState({ ...base, attention: () => Array.from({ length: 11 }, (_, i) => item(`a${i}`, `항목 ${i}`)), digest: () => digest(3, 2) });
  expect(st.waiting).toHaveLength(8);
  expect(st.waitingCount).toBe(11);
  expect(st.today).toEqual({ workMs: 3_600_000, done: 3, commits: 2, mains: 1 });
  expect(st.grass).toHaveLength(84);
});
