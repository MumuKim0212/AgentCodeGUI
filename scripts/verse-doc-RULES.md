# Verse API 주석 → 한국어 번역 규칙 (termbase)

번역 단계에서 각 LLM 작업자에게 그대로 주는 규칙. 용어 일관성과 코드 보존을 위한 기준이다.
결과는 코드 에디터 호버 카드에 그대로 표시된다.

## 절대 규칙
1. **백틱(`` ` ``) 안의 내용은 절대 번역/변형하지 않는다.** 백틱째 그대로 보존한다. 예: `` `vector3` ``, `` `Progress >= RequiredCount` ``, `` `agent` ``.
2. **코드 식별자·타입명·함수/파라미터명·Verse 키워드·지정자·경로(`/Verse.org/...` 등)·숫자·연산자**는 번역하지 않는다. 산문(설명 문장)만 번역한다.
3. **줄바꿈(`\n`)과 목록 구조(예: 줄 앞의 `*`, ` * `, 들여쓰기)는 원문 그대로 유지**한다.
4. 의미를 바꾸거나 내용을 덧붙이지 않는다. 설명/주석/메모를 추가하지 않는다.

## 톤
- 평서형 설명체. `~합니다` / `~입니다` 로 끝낸다.
- `<decides>` 함수의 "Succeeds if/when ..." → "~(하)면 성공합니다." / "Fails if ..." → "~(하)면 실패합니다."
- "Returns ..." → "~를 반환합니다." / "Gets ..." → "~를 가져옵니다." / "Sets ..." → "~로 설정합니다."
- "Used to ..." → "~하는 데 사용합니다." / "Makes a `X` ..." → "~하여 `X` 를 만듭니다."
- "Deprecated, use `X` instead." → "더 이상 사용되지 않습니다. 대신 `X` 를 사용하세요."
- "clamped between A and B" → "A 과 B 사이로 제한됩니다." (A, B 가 숫자면 백틱으로)
- "Signaled when/each time ..." → "~할 때(마다) 신호를 보냅니다."

## 용어집 (음차/번역 통일 — 단, 백틱 코드 토큰이면 그대로 둔다)
device→디바이스 · agent→에이전트 · entity→엔티티 · component→컴포넌트 · inventory→인벤토리 ·
widget→위젯 · slot→슬롯 · vehicle→차량 · turret→터렛 · sentry→센트리 · guard→가드 ·
spawn→스폰 · team→팀 · player→플레이어 · trace→트레이스 · collision→충돌 · specular→스페큘러 ·
highlight→하이라이트 · rotation→회전 · vector→벡터 · emote→이모트 · hologram→홀로그램 ·
mood→기분 · pawn→폰 · near plane→니어 평면 · world space→월드 공간 · centimeters→센티미터 ·
seconds→초 · quest→퀘스트 · sidekick→사이드킥 · volume→볼륨 · score→점수

게임 전용 표현은 음차+괄호 원문 병기 가능. 예: "down but not out" → "다운되었지만 탈락하지 않은(down but not out)".

## 입력 / 출력
- 입력: `{ key, src, decl, en }` 객체 배열. `decl`(선언 시그니처)·`src`(출처)는 **맥락 참고용**일 뿐 번역하지 않는다. `en` 만 번역.
- 출력: `{ "<key>": "<한국어 번역>" }` JSON 객체 하나. 입력의 모든 `key` 포함. JSON 외 텍스트 금지.
