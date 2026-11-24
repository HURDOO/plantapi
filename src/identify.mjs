// Pl@ntNet 호출과 API 초안 3.3(I-1) 형식 변환. 서버 밖으로 키가 새지 않도록 URL은 로그·에러에 넣지 않는다.

export const PLANTNET_URL = "https://my-api.plantnet.org/v2/identify/all";
export const ORGANS = ["auto", "leaf", "flower", "fruit", "bark"];
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CANDIDATE_LIMIT = 3;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 사진의 앞부분 바이트로 JPEG/PNG/WebP만 받는다. */
export function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export async function callPlantNet({ apiKey, photo, mimeType, organ, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const params = new URLSearchParams({
    "api-key": apiKey,
    "include-related-images": "false",
    "nb-results": String(CANDIDATE_LIMIT),
    lang: "en", // Pl@ntNet은 한국어 이름을 주지 않는다
  });
  const form = new FormData();
  form.append("organs", organ);
  form.append("images", new Blob([photo], { type: mimeType }), "photo");

  let res;
  try {
    res = await fetchImpl(`${PLANTNET_URL}?${params}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(502, "IDENTIFY_FAILED", "식별 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }

  if (res.status === 404) {
    throw new ApiError(404, "NO_PLANT_FOUND", "사진에서 식물을 찾지 못했어요. 잎이나 꽃이 잘 보이게 다시 찍어 주세요.");
  }
  if (res.status === 400 || res.status === 413 || res.status === 415) {
    throw new ApiError(400, "INVALID_PHOTO", "Pl@ntNet이 이 사진을 처리하지 못했어요. 다른 사진으로 시도해 주세요.");
  }
  if (!res.ok) {
    // 429(한도), 401/403(키), 5xx 모두 외부 서비스 문제로 본다
    throw new ApiError(502, "IDENTIFY_FAILED", `식별 서비스 오류예요 (Pl@ntNet ${res.status}).`);
  }
  try {
    return await res.json();
  } catch {
    throw new ApiError(502, "IDENTIFY_FAILED", "식별 서비스 응답을 읽지 못했어요.");
  }
}

/** Pl@ntNet 응답을 API 초안 I-1 응답 모양으로 바꾼다. DB가 없으니 DB에서 오는 칸은 null이다. */
export function toDraftResponse(plantnet, identificationId) {
  return {
    identification_id: identificationId,
    candidates: topResults(plantnet).map((r) => ({
        species_id: null,
        scientific_name: r.species?.scientificNameWithoutAuthor ?? null,
        korean_name: null,
        confidence: roundScore(r.score),
        character_id: null,
        is_collected: null,
        is_character_collected: null,
      })),
  };
}

/** 화면 표시용 보조 정보 (초안에는 없는 Pl@ntNet 원본 칸). */
export function toDetails(plantnet) {
  return {
    best_match: plantnet?.bestMatch ?? null,
    predicted_organs: (plantnet?.predictedOrgans ?? []).map((o) => ({ organ: o.organ, score: roundScore(o.score) })),
    remaining_requests: plantnet?.remainingIdentificationRequests ?? null,
    plantnet_version: plantnet?.version ?? null,
    candidates: topResults(plantnet).map((r) => ({
      scientific_name: r.species?.scientificNameWithoutAuthor ?? null,
      authorship: r.species?.scientificNameAuthorship ?? "",
      genus: r.species?.genus?.scientificNameWithoutAuthor ?? null,
      family: r.species?.family?.scientificNameWithoutAuthor ?? null,
      common_names: (r.species?.commonNames ?? []).slice(0, 3),
      gbif_id: r.gbif?.id ?? null,
      confidence: roundScore(r.score),
    })),
  };
}

function topResults(plantnet) {
  const results = Array.isArray(plantnet?.results) ? plantnet.results : [];
  return results
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, CANDIDATE_LIMIT);
}

function roundScore(score) {
  return typeof score === "number" ? Math.round(score * 10_000) / 10_000 : null;
}
