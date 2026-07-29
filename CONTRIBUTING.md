# 개발 규칙

## 브랜치
- `main`: 항상 정상 동작하는 상태만 유지합니다.
- 작업 시 `feature/번호-작업이름` 브랜치를 파서 씁니다. (예: `feature/03-guild-board`)
- 번호는 노션 "단계" 데이터베이스의 작업 번호와 맞춥니다.
- 작업이 끝나면 팀원이 한 번 실행해서 확인한 뒤 `main`에 merge합니다.

## 커밋 메시지
접두사 4개만 사용합니다.
- `feat:` 새 기능
- `fix:` 버그 수정
- `style:` 디자인/UI만 변경
- `docs:` 문서 변경

예: `feat: 게시판 화면 및 요청 로직 구현`

## 로컬 git 설정
커밋 전에 아래 명령으로 본인 이름/이메일을 설정해주세요 (팀원 롤 기술서의 근거 자료로도 쓰입니다).

```
git config --global user.name "본인 GitHub 아이디"
git config --global user.email "본인 이메일 또는 GitHub noreply 이메일"
```

## 작업 목록
전체 작업 목록과 진행 상황은 노션에서 관리합니다: (팀 노션 링크는 README 참고)
