import { riskyChoice } from '@core/away';

test('자리 비움: 되돌리기 어렵거나 밖으로 나가는 질문은 대신 고르지 않는다', () => {
  for (const q of ['옛 브랜치를 삭제할까요? 삭제 진행(추천) 그대로 두기', 'main 에 배포합니다. 진행 취소', '결과를 외부로 전송할까요?', 'Force push to origin? Yes No', 'rm -rf build 를 돌릴까요?', '토큰을 새로 발급할까요?', 'DB 를 초기화하고 다시 만들까요?', 'Delete the old files? Proceed (recommended)']) expect(riskyChoice(q)).toBe(true);
  for (const q of ['어떤 색? 빨강 파랑', '시험을 vitest 로 쓸까요 jest 로 쓸까요?', '함수 이름을 무엇으로 할까요? fetchUser loadUser', 'Which layout? Grid List', '폼 검증을 어디에 둘까요? 화면 서버']) expect(riskyChoice(q)).toBe(false);
});
