import type { Figure } from '@shared/types';

/** SVG 글을 이미지로 띄울 주소로. 이미지로 띄우면 스크립트가 돌지 않고 바깥 주소를 불러오지 않는다. */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** 그림마다 가장 새 판이 먼저 오게 묶는다 (판은 새것부터). */
export function groupFigures(list: Figure[]): { groupId: string; title: string; versions: Figure[] }[] {
  const out = new Map<string, { groupId: string; title: string; versions: Figure[] }>();
  for (const f of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const g = out.get(f.groupId) ?? { groupId: f.groupId, title: f.title, versions: [] };
    g.versions.push(f);
    out.set(f.groupId, g);
  }
  return [...out.values()];
}

/** 파일 이름으로 쓸 수 있게 */
export const fileName = (title: string, ext: string): string => `${title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'figure'}.${ext}`;
