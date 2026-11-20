import type { WorkspaceStatus } from '@shared/types';
import idle from './assets/steward.png';
import work from './assets/steward-work.png';
import wait from './assets/steward-wait.png';
import rest from './assets/steward-rest.png';
import idleFace from './assets/steward-face.png';
import workFace from './assets/steward-face-work.png';
import waitFace from './assets/steward-face-wait.png';
import restFace from './assets/steward-face-rest.png';

/** 비서의 모습: 지금 무엇을 하는지에 따라 달라진다 */
export type StewardMood = 'idle' | 'work' | 'wait' | 'rest';

/** 에이전트의 상태 → 비서의 모습. 꺼져 있으면 쉬고, 일하면 적고, 내 답을 기다리면 손을 든다. */
export function stewardMood(status: WorkspaceStatus | undefined): StewardMood {
  if (status === 'working') return 'work';
  if (status === 'waiting_user') return 'wait';
  if (status === undefined || status === 'stopped') return 'rest';
  return 'idle';
}

export const STEWARD_ART: Record<StewardMood, string> = { idle, work, wait, rest };
export const STEWARD_FACE: Record<StewardMood, string> = { idle: idleFace, work: workFace, wait: waitFace, rest: restFace };
export const STEWARD_MOOD_LABEL: Record<StewardMood, string> = { idle: '기다리는 중', work: '일하는 중', wait: '내 답을 기다립니다', rest: '쉬는 중' };
