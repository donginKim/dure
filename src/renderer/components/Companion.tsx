import { useEffect, useRef, useState } from 'react';
import { throttled } from '../throttle';
import type { ProjectDashboard } from '@shared/types';

/**
 * 도트 일꾼: 하단바 오른쪽에서 지금 상태를 몸짓으로 보여 준다. 두레를 위해 새로 그린 삿갓 쓴 농부다.
 * 일하는 중이면 호미질(일하는 에이전트 수만큼, 3명까지), 내 답을 기다리면 손을 들고 "!", 다 쉬면 앉아서 쉼,
 * 일을 끝내면 볏단을 들고 기뻐함, 사용 한도가 가까우면 땀을 흘림. LLM 을 부르지 않는다.
 */
type Mood = 'work' | 'wave' | 'rest' | 'cheer' | 'tired';

const COLORS: Record<string, string> = {
  h: 'var(--cp-hat)', H: 'var(--cp-hat-dark)', s: 'var(--cp-skin)', e: 'var(--cp-ink)', w: 'var(--cp-shirt)', p: 'var(--cp-pants)',
  t: 'var(--cp-wood)', b: 'var(--cp-metal)', g: 'var(--cp-sprout)', y: 'var(--cp-gold)', x: 'var(--warn)', d: 'var(--cp-drop)', z: 'var(--muted)', m: 'var(--cp-soil)',
};
// 16×14 칸. '.' 은 빈칸.
const BODY = [
  '................',
  '................',
  '......hh........',
  '....hhHHhh......',
  '..hhHHHHHHhh....',
  '.....ssss.......',
  '.....sess.......',
  '.....wwww.......',
  '....wwwwww......',
  '....swwwws......',
  '.....wwww.......',
  '.....pppp.......',
  '.....p..p.......',
  '....pp..pp......',
];
const put = (rows: string[], pts: [number, number, string][]): string[] => {
  const g = rows.map((r) => r.split(''));
  for (const [x, y, c] of pts) if (g[y] && x >= 0 && x < 16) g[y]![x] = c;
  return g.map((r) => r.join(''));
};
const FRAMES: Record<Mood, string[][]> = {
  // 호미를 들었다 내린다. 앞에 모가 자란다.
  work: [
    put(BODY, [[10, 9, 't'], [11, 8, 't'], [12, 7, 't'], [13, 6, 'b'], [13, 7, 'b'], [12, 13, 'g'], [12, 12, 'g'], [11, 13, 'm'], [13, 13, 'm']]),
    put(BODY, [[10, 9, 't'], [11, 10, 't'], [12, 11, 't'], [13, 12, 'b'], [14, 12, 'b'], [12, 13, 'm'], [13, 13, 'm'], [14, 13, 'g']]),
  ],
  // 손을 들고 "!"
  wave: [
    put(BODY, [[9, 9, 'w'], [10, 8, 's'], [10, 7, 's'], [14, 1, 'x'], [14, 2, 'x'], [14, 3, 'x'], [14, 5, 'x']]),
    put(BODY, [[9, 9, 'w'], [10, 8, 's'], [11, 7, 's'], [14, 0, 'x'], [14, 1, 'x'], [14, 2, 'x'], [14, 4, 'x']]),
  ],
  // 앉아서 쉰다 (z 가 떠오른다)
  rest: [
    put(BODY.slice(0, 11).concat(['....pppppp......', '................', '................']).slice(0, 14), [[13, 5, 'z'], [14, 4, 'z']]),
    put(BODY.slice(0, 11).concat(['....pppppp......', '................', '................']).slice(0, 14), [[14, 3, 'z'], [15, 2, 'z']]),
  ],
  // 볏단을 들고 뛴다
  cheer: [
    put(BODY, [[3, 8, 's'], [10, 8, 's'], [2, 7, 'y'], [3, 7, 'y'], [2, 6, 'y'], [11, 7, 'y'], [10, 7, 'y'], [11, 6, 'y']]),
    put(['................', ...BODY.slice(0, 13)], [[3, 9, 's'], [10, 9, 's'], [2, 8, 'y'], [3, 8, 'y'], [2, 7, 'y'], [11, 8, 'y'], [10, 8, 'y'], [11, 7, 'y']]),
  ],
  // 땀을 흘리며 천천히
  tired: [
    put(BODY, [[10, 9, 't'], [11, 10, 't'], [12, 11, 't'], [13, 12, 'b'], [9, 5, 'd']]),
    put(BODY, [[10, 9, 't'], [11, 10, 't'], [12, 11, 't'], [13, 12, 'b'], [9, 6, 'd']]),
  ],
};

function Sprite({ mood, frame, px = 2 }: { mood: Mood; frame: number; px?: number }) {
  const rows = FRAMES[mood][frame % FRAMES[mood].length]!;
  return (
    <svg width={16 * px} height={14 * px} viewBox="0 0 16 14" shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((r, y) => r.split('').map((c, x) => (c === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={COLORS[c]} />)))}
    </svg>
  );
}

export function Companion({ onOpenAttention, limitHot }: { onOpenAttention: () => void; limitHot: boolean }) {
  const [dash, setDash] = useState<ProjectDashboard[]>([]);
  const [doing, setDoing] = useState<Record<string, { text: string }>>({});
  const [frame, setFrame] = useState(0);
  const [cheerUntil, setCheerUntil] = useState(0);
  const lastDone = useRef<number | null>(null);
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    let alive = true;
    const load = throttled(() => {
      window.dure.projects.dashboard().then((d) => {
        if (!alive) return;
        setDash(d);
        // 끝낸 TODO 가 늘었으면 잠깐 기뻐한다
        const done = d.reduce((n, p) => n + p.todos.done, 0);
        if (lastDone.current !== null && done > lastDone.current) setCheerUntil(Date.now() + 4000);
        lastDone.current = done;
      }).catch(() => undefined);
      window.dure.workspaces.doing().then((x) => { if (alive) setDoing(x); }).catch(() => undefined);
    }, 3000);
    load();
    const t = setInterval(load, 10_000);
    const off = window.dure.onChanged((topic) => { if (topic === 'workspaces' || topic === 'todos') load(); });
    return () => { alive = false; clearInterval(t); off(); load.cancel(); };
  }, []);
  useEffect(() => {
    if (still) return;
    const t = setInterval(() => setFrame((f) => f + 1), 450);
    return () => clearInterval(t);
  }, [still]);
  const working = dash.reduce((n, p) => n + p.agents.working, 0);
  const waiting = dash.reduce((n, p) => n + p.agents.waiting, 0);
  const mood: Mood = waiting > 0 ? 'wave' : Date.now() < cheerUntil ? 'cheer' : working > 0 ? (limitHot ? 'tired' : 'work') : 'rest';
  const count = mood === 'work' || mood === 'tired' ? Math.min(3, Math.max(1, working)) : 1;
  const firstDoing = Object.values(doing)[0]?.text;
  const tip = mood === 'wave' ? `에이전트 ${waiting}명이 내 답을 기다립니다 (누르면 확인할 것을 엽니다)`
    : mood === 'cheer' ? '일을 끝냈습니다!'
      : mood === 'rest' ? '모두 쉬는 중입니다'
        : `에이전트 ${working}명이 일하는 중${firstDoing ? ` · ${firstDoing}` : ''}${limitHot ? ' · 사용 한도가 가깝습니다' : ''}`;
  return (
    <button className={`companion ${mood}`} title={tip} aria-label={tip} onClick={() => { if (waiting > 0) onOpenAttention(); }}>
      {Array.from({ length: count }, (_, i) => <Sprite key={i} mood={mood} frame={frame + i} />)}
    </button>
  );
}
