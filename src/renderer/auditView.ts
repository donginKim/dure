import type { AuditActorKind, AuditEntry, AuditOutcome } from '@shared/types';

export const ACTOR_LABEL: Record<AuditActorKind, string> = { user: '사용자', agent: '에이전트', peer: '다른 사람', system: '두레' };
export const OUTCOME_LABEL: Record<AuditOutcome, string> = { ok: '됨', denied: '거절·보류', failed: '실패' };

/** 거르기에 쓰는 묶음: 동작 이름의 앞머리로 가른다. */
export const GROUPS: { id: string; label: string; prefixes: string[] }[] = [
  { id: 'agent', label: '에이전트', prefixes: ['agent.', 'tool.', 'agent_config.', 'away.', 'model.', 'shell.'] },
  { id: 'code', label: '코드', prefixes: ['commit.', 'merge.', 'autoship.', 'pr.', 'checkpoint.', 'verify.', 'review.', 'cleanup.'] },
  { id: 'data', label: 'DB·슬랙·브라우저', prefixes: ['db.', 'slack.', 'browser.', 'tool.db_', 'tool.slack_', 'tool.browser_'] },
  { id: 'people', label: '다른 사람', prefixes: ['peer.', 'share.', 'assign.', 'workspace.sharing'] },
  { id: 'plan', label: '계획·할 일', prefixes: ['plan.', 'todo.', 'schedule.', 'memory.', 'agreement.', 'message.'] },
  { id: 'setup', label: '설정·플러그인', prefixes: ['settings.', 'plugin.', 'project.', 'repo.', 'workspace.', 'make.', 'app.', 'audit.'] },
];

const LABELS: Record<string, string> = {
  'project.create': '프로젝트 만들기', 'project.remove': '프로젝트 지우기', 'project.reopen': '프로젝트 다시 열기', 'project.complete': '프로젝트 완료 처리',
  'project.autoship': '자동 반영 설정', 'project.budget': '예산 설정', 'project.budget.allow_today': '오늘만 예산 더 쓰기',
  'repo.add': '저장소 등록', 'repo.remove': '저장소 빼기', 'repo.verify_command': '확인 명령 설정',
  'workspace.create': '워크스페이스 만들기', 'workspace.remove': '워크스페이스 지우기', 'workspace.permission_mode': '권한 모드 변경', 'workspace.model': '모델 변경',
  'workspace.engine': '대화 방식 변경', 'workspace.sharing': '워크스페이스 공개 범위', 'agent_config.trust': '에이전트 설정 파일 허용',
  'agent.start': '에이전트 시작 (사용자)', 'agent.launch': '에이전트 실행', 'agent.stop': '에이전트 끄기', 'agent.interrupt': '에이전트 멈춤', 'shell.open': '셸 열기',
  'agent.prompt': '에이전트에게 지시', 'agent.permission': '실행 승인 응답', 'agent.question.answer': '질문에 답함', 'agent.question.dismiss': '질문 넘김',
  'away.auto_answer': '자리 비움: 대신 답함', 'away.review': '자리 비움 기록 확인', 'model.call': '모델 호출 (리뷰·만들기)',
  'message.send': '에이전트에게 메시지', 'message.pause_project': '전체 멈춤·재개', 'message.resume': '대화 상한 풀기',
  'plan.approve': '계획안 승인', 'plan.reject': '계획안 거절', 'plan.revise': '계획안 고치게 함',
  'todo.add': 'TODO 추가', 'todo.update': 'TODO 수정', 'todo.remove': 'TODO 삭제',
  'schedule.save': '예약 저장', 'schedule.remove': '예약 삭제', 'schedule.enable': '예약 켜기·끄기', 'schedule.run_now': '예약 바로 실행', 'schedule.run': '예약 실행',
  'memory.add': '기억 추가', 'memory.remove': '기억 삭제', 'agreement.save': '약속 저장', 'agreement.accept': '약속 받아들임', 'agreement.remove': '약속 삭제',
  'commit.create': '커밋', 'commit.push': 'push', 'pr.create': 'PR 만들기', 'merge.prepare': '합쳐서 확인', 'merge.advance': '기준 브랜치 옮김',
  'autoship.stop': '자동 반영 멈춤', 'autoship.commit': '자동 반영: 커밋', 'autoship.merge': '자동 반영: 기준 브랜치로', 'checkpoint.restore': '되돌리기 지점으로 복원',
  'verify.run': '확인 명령 실행', 'review.run': '리뷰 실행', 'cleanup.restore': '정리 대기에서 복원', 'cleanup.export': '정리 대기 꺼내기',
  'db.connection.save': 'DB 연결 저장', 'db.connection.remove': 'DB 연결 삭제', 'db.query.user': 'DB 조회 (사용자)', 'db.query.decide': 'DB 조회 승인 응답',
  'slack.connect': '슬랙 연결', 'slack.disconnect': '슬랙 연결 끊기', 'slack.access': '슬랙 읽기 방식', 'slack.read.decide': '슬랙 읽기 승인 응답', 'browser.open.decide': '브라우저 주소 승인 응답',
  'peer.connect': '다른 사람에게 연결 요청', 'peer.pair.accept': '연결 수락', 'peer.pair.dismiss': '연결 거절', 'peer.remove': '연결 끊기', 'peer.mode': '메시지 받는 방식',
  'peer.message.pass': '보류된 메시지 전달', 'peer.message.drop': '보류된 메시지 버림',
  'share.create': '함께하는 프로젝트로 열기', 'share.invite': '초대', 'share.invite.accept': '초대 수락', 'share.invite.decline': '초대 거절', 'share.leave': '함께하기에서 나감',
  'share.member.remove': '참여자 내보냄', 'share.lead.hand_over': '리더 넘김', 'assign.accept': '받은 일 수락', 'assign.decline': '받은 일 거절',
  'plugin.install': '플러그인 설치', 'plugin.update': '플러그인 다시 받기', 'plugin.approve': '플러그인 승인', 'plugin.remove': '플러그인 삭제', 'plugin.enable': '플러그인 켜기·끄기',
  'make.create': '만들기', 'make.save': '만든 문서 저장', 'make.remove': '만든 문서 삭제', 'settings.update': '설정 변경', 'app.update': '앱 업데이트',
  'audit.export': '감사 기록 내보내기', 'audit.prune': '오래된 감사 기록 삭제',
};

/** 동작 이름을 사람이 읽는 말로. 에이전트의 도구 호출(tool.*)은 도구 이름을 그대로 보인다. */
export function actionLabel(action: string): string {
  if (LABELS[action]) return LABELS[action];
  if (action.startsWith('tool.')) return `도구: ${action.slice(5)}`;
  return action;
}

export function groupOf(action: string): string {
  // 더 긴 앞머리가 먼저다 (tool.db_ 는 '에이전트' 가 아니라 'DB·슬랙·브라우저')
  let best = ''; let id = '';
  for (const g of GROUPS) for (const p of g.prefixes) if (action.startsWith(p) && p.length > best.length) { best = p; id = g.id; }
  return id;
}

export const detailText = (e: AuditEntry): string => Object.entries(e.detail).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `${k}=${String(v)}`).join(' · ');

export const timeText = (at: number): string => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
