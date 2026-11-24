# plantapi — 식물 식별 API 테스트

**이세계 엘프들**(GDGoC 26-2) 팀원들이 Pl@ntNet 식별 API를 직접 써 보는 프로토타입입니다.
사진을 올리면 Pl@ntNet 결과와, API 초안 **3.3 I-1** `POST /functions/v1/identify` 응답 모양을 함께 보여 줍니다.

- 폰 카메라나 앨범에서 사진을 고르면, 앱 규칙대로 긴 변 1280px, JPEG 품질 0.7로 줄여서 보냅니다.
- 사진 부위(organ)는 `auto`(기본), `leaf`, `flower`, `fruit`, `bark` 중에서 고릅니다. 회의 안건인 "부위를 직접 고르게 할지"를 비교해 보는 용도입니다.
- 후보 3개의 학명, 일반명, 신뢰도, 속·과와 Pl@ntNet이 판단한 부위, 남은 요청 수를 보여 줍니다.
- 탭에서 두 가지 JSON을 볼 수 있습니다.
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

## 구조

- `src/identify.mjs`: Pl@ntNet 호출, 에러 매핑, I-1 형식 변환
- `src/server.mjs`: HTTP 서버 (`/`, `/healthz`, `/api/status`, `POST /api/identify?organ=`)
- `public/`: 테스트 화면
- `test/`: Pl@ntNet을 흉내 낸 서버 테스트

Pl@ntNet 키는 URL 쿼리로 전달됩니다. 그래서 요청 URL과 원본 에러는 로그에 남기지 않습니다.

## 배포

라즈베리파이 deployd에서 `https://plantapi.app.hurdoo.kr`로 배포합니다. 설정은 `deploy.json`에 있습니다.

- secret: `PLANTNET_API_KEY` (필수). deployd 대시보드의 **Secrets**에서 등록합니다.
- 화면에 보이는 설정: `IDENTIFY_DAILY_LIMIT` (기본 150). Pl@ntNet 무료 키는 서비스 전체에서 하루 500회까지 쓸 수 있습니다.
