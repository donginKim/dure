import type { AttentionItem } from '@shared/types';
import { attentionTarget, groupAttention } from '../../src/renderer/attentionView';

const item = (o: Partial<AttentionItem>): AttentionItem => ({ id: 'x', kind: 'agent', projectId: 'p1', projectName: '가', workspaceId: null, title: '', detail: '', ...o });

test('항목을 누르면 그것을 처리하는 화면으로 간다', () => {
  const coordinators = new Set(['c1']);
  expect(attentionTarget(item({ kind: 'agent', workspaceId: 'w1' }), coordinators)).toEqual({ type: 'workspace', id: 'w1', projectId: 'p1' });
  // 조율 에이전트의 것은 프로젝트 화면 (조율 탭)
  expect(attentionTarget(item({ kind: 'plan', workspaceId: 'c1' }), coordinators)).toEqual({ type: 'project', id: 'p1' });
  expect(attentionTarget(item({ kind: 'assign' }), coordinators)).toEqual({ type: 'project', id: 'p1' });
  expect(attentionTarget(item({ kind: 'pair', projectId: null }), coordinators)).toEqual({ type: 'people' });
  expect(attentionTarget(item({ kind: 'invite', projectId: null }), coordinators)).toEqual({ type: 'people' });
});

test('프로젝트마다 묶고, 사람에 관한 것은 맨 위에 둔다', () => {
  const g = groupAttention([item({ id: '1' }), item({ id: '2', projectId: 'p2', projectName: '나' }), item({ id: '3', kind: 'pair', projectId: null, projectName: '' }), item({ id: '4' })]);
  expect(g.map((x) => [x.projectId, x.items.map((i) => i.id)])).toEqual([[null, ['3']], ['p1', ['1', '4']], ['p2', ['2']]]);
});

test('여러 건을 합친 알림을 누르면 확인할 것 목록으로 간다', () => {
  expect(attentionTarget({ kind: 'list' as never, projectId: 'p', workspaceId: 'w' }, new Set())).toEqual({ type: 'attention' });
});
