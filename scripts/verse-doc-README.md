# Verse 호버 문서 한국어 번역 팩 — 생성 파이프라인

UEFN이 깔아두는 Verse API 다이제스트(`/Verse.org`, `/UnrealEngine.com`, `/Fortnite.com`)의
영어 doc 주석을 한 번 한국어로 번역해 **콘텐츠 해시 → 한국어** 맵으로 만든다. 앱은 런타임에
호버 시 영어 doc의 해시로 이 팩을 조회해 한국어로 바꿔 보여준다 (LSP/네트워크/LLM 호출 없음).

- **최종 산출물(앱에 번들):** `src/main/lsp/verse-doc-ko.json` — `{ sha1(en).slice(0,12): ko }`
- **런타임 소비:** `src/main/lsp/verseDocKo.ts` → `extractVerseDoc`(verse.ts)에서 호출
- **켜기/끄기:** 설정 > 분석 서버 > "Verse 공식 문서 한국어 보기" (`ui-prefs.json`의 `verseDocLang`)

키는 `extractVerseDoc`(verse.ts)와 **동일한 추출 규칙**으로 만든 영어 doc 문자열의 sha1. 그래서
런타임 추출 문자열과 빌드 추출 문자열이 바이트 단위로 같아 매칭된다. 팩에 없는 항목(유저 코드
주석·신규 API)은 영어 원문으로 폴백한다.

## Verse 버전이 올라 다이제스트가 바뀌면 (재생성)

```bash
# 1) 다이제스트에서 doc 블록 추출 (해시 dedup)
node scripts/verse-doc-extract.cjs > .tmp-verse/blocks.json

# 2) 번역용으로 N개 청크로 분할
node scripts/verse-doc-split.cjs 16

# 3) 각 청크를 LLM으로 번역 → .tmp-verse/ko/ko-NN.json
#    규칙/용어집은 scripts/verse-doc-RULES.md 를 작업자에게 그대로 준다.
#    (기존 verse-doc-ko.json 을 시드로 두면 안 바뀐 키는 재번역 없이 재사용 가능)

# 4) 병합 + 검증(키 누락/빈값 차단, 백틱 코드 보존 경고) → .tmp-verse/verse-doc-ko.json
node scripts/verse-doc-merge.cjs
#    수정이 필요하면 .tmp-verse/fixes.json 에 { key: 교정한국어 } 로 덮어쓴다.

# 5) 팩을 앱 소스로 복사
cp .tmp-verse/verse-doc-ko.json src/main/lsp/verse-doc-ko.json
```

검수용(선택): `verse-doc-sample.cjs`(대표 샘플 추출) → `verse-doc-html.cjs`(원문↔한국어 비교
HTML을 바탕화면에 생성). `verse-doc-inspect.cjs <key…>`는 특정 블록의 EN/KO/백틱을 출력한다.

`.tmp-verse/`는 작업 스크래치라 git에 올리지 않는다(`.gitignore`). 번역 결과의 영속본은
`src/main/lsp/verse-doc-ko.json` 하나다.
