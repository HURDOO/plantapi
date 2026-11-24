# plantapi — 식물 식별 API 테스트

**이세계 엘프들**(GDGoC 26-2) 팀원들이 Pl@ntNet 식별 API를 직접 써 보는 프로토타입입니다.
사진을 올리면 Pl@ntNet 결과와, API 초안 **3.3 I-1** `POST /functions/v1/identify` 응답 모양을 함께 보여 줍니다.

- 사진을 넣으면 바로 식별합니다. 카메라, 앨범(여러 장), 드래그, 붙여넣기 모두 됩니다. 앱 규칙대로 긴 변 1280px, JPEG 품질 0.7로 줄여서 한 장씩 차례로 보냅니다.
- 샘플 60장(`public/samples/`)을 누르면 바로 식별하고 기준 종과 비교해 보여 줍니다. 안암 일대 사용자 사진, 국내 사용자 관찰 사진, 위키 대표 사진이 각각 20장씩 있습니다. `/?sample=<id>`로 바로 열 수도 있습니다.
- `/report`: 샘플 60장(안암 일대 사진, 사용자 관찰 사진, 위키 대표 사진 20장씩) 정확도 보고서입니다. 수치는 `public/report/results-anam.json`, `results-community.json`, `results.json`에서 계산합니다.
- 사진 부위(organ)는 고급 설정에 있습니다. 위키 사진 15장 테스트에서는 지정해도 결과가 같았습니다.
- Pl@ntNet에는 후보 10개를 요청하고(요청 1회로 같음), 화면과 I-1 응답에는 3개만 보여 줍니다. 4~10위는 결과 카드에서 접어서 볼 수 있습니다.
- 엘프 판정 단계(속 / 과 / 보류)를 함께 보여 줍니다. 1위 속이 2위 속의 2배 이상이면 속, 아니면 한 과가 80% 이상일 때 과, 둘 다 아니면 다시 찍기입니다 (`src/identify.mjs`의 `elfDecision`).
- 후보 3개의 학명, 일반명, 신뢰도, 속·과와 Pl@ntNet이 판단한 부위, 남은 요청 수를 보여 줍니다.
- 결과 카드마다 두 가지 JSON을 펼쳐 보고 복사할 수 있습니다.
  - **I-1 응답(초안 형식)**: `species_id`, `korean_name`, `character_id`, `is_collected`, `is_character_collected`는 DB에서 채우는 칸이라 `null`입니다.
  - **Pl@ntNet 원본**: Pl@ntNet이 돌려준 응답 그대로입니다.
- 에러는 초안 형식 `{ "error": { "code", "message" } }`을 따릅니다.

| 상태 | code | 상황 |
|---|---|---|
| 400 | `INVALID_PHOTO` | 사진이 아니거나 8MB 초과, 또는 Pl@ntNet이 사진을 거절함 |
| 404 | `NO_PLANT_FOUND` | Pl@ntNet이 식물을 찾지 못함 |
| 429 | `DAILY_LIMIT` | 이 서버의 하루 한도(`IDENTIFY_DAILY_LIMIT`, 한국 시간 기준) 초과 |
| 502 | `IDENTIFY_FAILED` | Pl@ntNet 오류, 키 문제, Pl@ntNet 한도 초과 |

사진과 결과는 저장하지 않습니다. 하루 사용량은 메모리에서만 세므로 서버를 다시 시작하면 0부터 다시 셉니다.

## 로컬 실행

Node.js 24 이상이 필요하고, 의존성은 없습니다.

```bash
cp .env.example .env      # PLANTNET_API_KEY에 키를 넣는다 (커밋 금지)
npm run dev               # http://127.0.0.1:3000
npm run check             # 문법 검사 + 테스트
```

## 평가 다시 돌리기

```bash
node --env-file=.env scripts/evaluate.mjs             # 위키 사진, Pl@ntNet 약 35회 호출 → public/report/results.json
node --env-file=.env scripts/evaluate.mjs community   # 사용자 사진, 20회 호출 → public/report/results-community.json
node --env-file=.env scripts/evaluate.mjs anam        # 안암 사진, 20회 호출 → public/report/results-anam.json
```

후보 3개와 10개 비교: `node --env-file=.env scripts/compare-nb.mjs` (120회 호출 → `public/report/nb-compare.json`).

사용자·안암 사진은 앱과 같게 긴 변 1280px, JPEG 품질 0.7로 줄여서 보냅니다 (macOS `sips` 사용).

보고서용 사진의 정답과 출처는 `public/samples/manifest.json`에 있습니다. iNaturalist 사진의 기준 종은 커뮤니티에서 확인한 관찰 기록을 따르며, 촬영자와 라이선스는 `public/samples/community.json`과 테스트 화면에서 확인할 수 있습니다.

안암 사진의 촬영 위치, 동정 출처, 촬영자는 `public/samples/anam.json`에 있습니다. 안암동 15장과 성북천·고려대 인근 5장으로, 사진을 리사이즈했으며 CC BY-NC 4.0 비영리 이용 조건이 적용됩니다.

## 구조

- `src/identify.mjs`: Pl@ntNet 호출, 에러 매핑, I-1 형식 변환
- `src/server.mjs`: HTTP 서버 (`/`, `/healthz`, `/api/status`, `POST /api/identify?organ=`)
- `public/`: 테스트 화면(`index.html`, `app.js`), 보고서(`report.html`, `report.js`), 샘플 사진과 평가 결과
- `test/`: Pl@ntNet을 흉내 낸 서버 테스트

Pl@ntNet 키는 URL 쿼리로 전달됩니다. 그래서 요청 URL과 원본 에러는 로그에 남기지 않습니다.

## 배포

라즈베리파이 deployd에서 `https://plantapi.app.hurdoo.kr`로 배포합니다. 설정은 `deploy.json`에 있습니다.

- secret: `PLANTNET_API_KEY` (필수). deployd 대시보드의 **Secrets**에서 등록합니다.
- 화면에 보이는 설정: `IDENTIFY_DAILY_LIMIT` (기본 150). Pl@ntNet 무료 키는 서비스 전체에서 하루 500회까지 쓸 수 있습니다.
