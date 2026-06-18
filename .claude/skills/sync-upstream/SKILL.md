---
name: sync-upstream
description: 원본(upstream) 레포의 변경사항을 fetch해서 검토하고, 전체 병합 / 특정 커밋 cherry-pick / 특정 파일만 가져오기 중 사용자가 선택한 방식으로 fork에 반영한다. fork 동기화, 원본 변경사항 가져오기, upstream sync, "원본이랑 맞춰줘" 같은 요청 시 사용.
---

# Sync Upstream — 원본 변경사항 선택적 반영

이 레포는 fork다. remote 구성:
- `origin` → 내 fork (`MumuKim0212/AgentCodeGUI`)
- `upstream` → 원본 (`UnrealFactory/AgentCodeGUI`)

목표: 원본의 새 변경사항을 **검토한 뒤, 원하는 것만 골라서** 내 fork에 반영한다.
절대 무턱대고 전체 병합하지 말 것. 항상 먼저 보여주고 사용자에게 방식을 확인받는다.

## 1단계: 가져오기 + 차이 검토 (항상 먼저 실행)

```bash
git fetch upstream
```

그 다음 차이를 확인하고 사용자에게 보고한다:

```bash
# 작업 트리가 깨끗한지 (커밋 안 한 변경 있으면 먼저 알린다)
git status --short

# 현재 브랜치 확인
git branch --show-current

# upstream에는 있고 내 브랜치엔 아직 없는 커밋 (= 가져올 후보)
git log --oneline --no-merges HEAD..upstream/main

# 내 fork에만 있는 커밋 (= 내가 한 수정. 충돌 가능성 판단용)
git log --oneline --no-merges upstream/main..HEAD

# 파일 단위 변경 요약
git diff --stat HEAD..upstream/main
```

- 가져올 커밋이 **없으면** "이미 최신 상태"라고 알리고 종료.
- 가져올 커밋이 있으면 각 커밋의 해시·메시지·변경 파일을 **목록으로 정리해서** 사용자에게 보여준다.
- 작업 트리가 더럽거나(uncommitted changes) 현재 브랜치가 `main`이 아니면 먼저 알리고 진행 여부를 확인한다.

## 2단계: 방식 선택 (사용자에게 물어본다)

AskUserQuestion으로 어떻게 반영할지 묻는다. 보기:

| 방식 | 언제 | 결과 |
|------|------|------|
| **전체 병합** | 원본 변경을 다 따라가고 싶을 때 | `git merge upstream/main` |
| **커밋 골라오기 (cherry-pick)** | 일부 커밋만 원할 때 | 선택한 커밋만 적용 |
| **파일만 가져오기** | 특정 파일을 원본 버전으로 덮어쓸 때 | 선택 파일만 교체 |
| **취소** | 지금은 안 가져옴 | 아무것도 안 함 |

cherry-pick / 파일 가져오기를 고르면, 1단계에서 보여준 목록을 근거로 **구체적으로 어떤 커밋/파일인지** 다시 확인받는다.

## 3단계: 실행

안전을 위해 작업 전 현재 위치에 백업 브랜치를 만들어 둘 것을 권장:
```bash
git branch backup/pre-sync-$(date +%Y%m%d-%H%M%S)
```

### A) 전체 병합
```bash
git merge upstream/main
```

### B) 커밋 골라오기 (cherry-pick)
```bash
git cherry-pick <해시1> <해시2> ...
```
- 범위로도 가능: `git cherry-pick A^..B` (A부터 B까지)

### C) 특정 파일만 가져오기
```bash
git checkout upstream/main -- <경로/파일1> <경로/파일2>
git status        # 스테이징된 변경 확인
# 사용자가 확인하면 커밋
git commit -m "원본에서 <파일> 가져옴"
```

## 4단계: 충돌 처리

충돌이 나면 (`CONFLICT` 메시지):

```bash
git status        # 충돌 파일 목록
```

각 충돌 파일을 열어 `<<<<<<<`, `=======`, `>>>>>>>` 마커를 확인한다.
- `HEAD` 쪽 = 내 fork 수정
- 다른 쪽 = 원본 변경

각 충돌마다 어느 쪽을 살릴지(또는 둘 다 합칠지) **사용자에게 보여주고 확인**한 뒤 해결한다. 임의로 한쪽을 버리지 말 것.

해결 후:
```bash
git add <해결한파일>
# merge였으면:
git commit
# cherry-pick이었으면:
git cherry-pick --continue
```

중단하고 원래대로 되돌리려면:
```bash
git merge --abort          # 또는
git cherry-pick --abort
```

## 5단계: 마무리

```bash
git log --oneline -5      # 결과 확인
```

- 무엇을 가져왔는지(커밋/파일), 충돌은 어떻게 해결했는지 요약 보고.
- push는 사용자가 명시적으로 요청할 때만:
  ```bash
  git push origin <브랜치>
  ```

## 원칙
- 검토 → 확인 → 실행 순서를 절대 건너뛰지 않는다.
- 충돌 해결과 push는 사용자 확인 없이 하지 않는다.
- 파괴적 작업(reset --hard 등) 전엔 백업 브랜치를 제안한다.
