import type { AttentionItem, DailyDigest, PaddyDay, Project, TrayState, Workspace } from '@shared/types';

/** 메뉴 막대의 작은 창에 보일 것을 모은다. 이미 있는 기록만 읽는다 (LLM 을 부르지 않는다). */
export function trayState(d: {
  stewardName: string;
  attention(): AttentionItem[];
  projects(): Project[];
  workspaces(projectId: string): Workspace[];
  /** 워크스페이스가 지금 하는 일 한 줄 (없으면 빈 글) */
  doing(workspaceId: string): string;
  digest(): DailyDigest;
  grass(days: number): PaddyDay[];
}): TrayState {
  const all = d.attention();
  const agents: TrayState['agents'] = [];
  for (const p of d.projects()) {
    if (p.status === 'done') continue;
    for (const w of d.workspaces(p.id)) {
      if (w.status !== 'working' && w.status !== 'waiting_user') continue;
      agents.push({ workspaceId: w.id, projectId: p.id, project: p.name, name: w.role === 'coordinator' ? '조율 에이전트' : w.name, status: w.status, doing: d.doing(w.id) || w.summary || '' });
    }
  }
  // 내 답을 기다리는 것이 앞에 온다.
  agents.sort((a, b) => Number(b.status === 'waiting_user') - Number(a.status === 'waiting_user'));
  const t = d.digest().totals;
  return {
    stewardName: d.stewardName,
    mood: all.length > 0 ? 'wait' : agents.some((a) => a.status === 'working') ? 'work' : 'rest',
    waiting: all.slice(0, 8), waitingCount: all.length,
    agents: agents.slice(0, 12),
    today: { workMs: t.workMs, done: t.done, commits: t.commits, mains: t.mains },
    grass: d.grass(84),
  };
}
