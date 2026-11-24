// Pl@ntNet 호출과 API 초안 3.3(I-1) 형식 변환. 서버 밖으로 키가 새지 않도록 URL은 로그·에러에 넣지 않는다.

export const PLANTNET_URL = "https://my-api.plantnet.org/v2/identify/all";
export const ORGANS = ["auto", "leaf", "flower", "fruit", "bark"];
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CANDIDATE_LIMIT = 3; // I-1 응답·화면에 보여주는 후보 수
// Pl@ntNet에 요청하는 후보 수. 몇 개를 받든 요청 1회로 센다.
// 60장 비교(public/report/nb-compare.json): 상위 3개는 같고, 4~10위에서 정답 종이 3장 더 나왔다 (응답 중앙값 +61ms).
export const REQUEST_RESULTS = 10;
// 엘프 판정 단계 규칙: 1위 속이 2위 속의 2배 이상이면 속, 아니면 한 과가 80% 이상일 때 과, 둘 다 아니면 다시 찍기.
export const ELF_RULE = { genusRatio: 2, familyShare: 0.8 };

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

function plantNetParams(apiKey, nbResults = REQUEST_RESULTS) {
  return new URLSearchParams({
    "api-key": apiKey,
    "include-related-images": "false",
    "nb-results": String(nbResults),
    lang: "en", // Pl@ntNet은 한국어 이름을 주지 않는다
  });
}

/** 화면의 "입력·출력"에 보여줄 Pl@ntNet 요청 모양. 키는 가린다. */
export function describePlantNetRequest({ organ, mimeType, bytes }) {
  return {
    method: "POST",
    url: `${PLANTNET_URL}?${plantNetParams("•••").toString().replace("%E2%80%A2%E2%80%A2%E2%80%A2", "•••")}`,
    content_type: "multipart/form-data",
    form: { organs: organ, images: `photo (${mimeType}, ${bytes} bytes)` },
  };
}

export async function callPlantNet({ apiKey, photo, mimeType, organ, nbResults, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const params = plantNetParams(apiKey, nbResults);
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
    genus_summary: genusSummary(plantnet),
    elf_decision: elfDecision(plantnet),
    more_candidates: moreCandidates(plantnet),
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

/** 화면에는 안 보이는 4위 이후 후보 (DB에서 한국 종을 찾을 때 쓴다). */
export function moreCandidates(plantnet) {
  return sortedResults(plantnet).slice(CANDIDATE_LIMIT).map((r) => ({
    scientific_name: r.species?.scientificNameWithoutAuthor ?? null,
    genus: genusOf(r),
    family: familyOf(r),
    confidence: roundScore(r.score),
  }));
}

/**
 * 엘프를 어느 단계(속·과)까지 정할지. 받은 후보 전체(최대 10개)의 점수를 속별·과별로 더해 본다.
 * - genus: 1위 속이 2위 속보다 2배 이상 (속이 하나뿐이어도 genus)
 * - family: 속은 갈리지만 한 과가 전체 점수의 80% 이상 (예: 밀·호밀 → 벼과)
 * - retake: 둘 다 아님 → 한 장 더 찍기
 */
export function elfDecision(plantnet) {
  const all = sortedResults(plantnet);
  if (!all.length) return null;
  const total = all.reduce((sum, r) => sum + (r.score ?? 0), 0);
  const sumBy = (key) => {
    const m = new Map();
    for (const r of all) m.set(key(r), (m.get(key(r)) ?? 0) + (r.score ?? 0));
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const genera = sumBy(genusOf);
  const families = sumBy(familyOf);
  const topGenus = genusOf(all[0]);
  const ratio = genera.length > 1 && genera[1][1] > 0 ? genera[0][1] / genera[1][1] : null;
  const familyShare = total > 0 ? families[0][1] / total : 0;
  let level = "retake";
  if (genera[0][0] === topGenus && (ratio === null || ratio >= ELF_RULE.genusRatio)) level = "genus";
  else if (familyShare >= ELF_RULE.familyShare) level = "family";
  return {
    level,
    genus: level === "genus" ? topGenus : null,
    family: level === "family" ? families[0][0] : familyOf(all[0]),
    genus_ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    family_share: roundScore(familyShare),
    results_used: all.length,
  };
}

const genusOf = (r) => r.species?.genus?.scientificNameWithoutAuthor ?? null;
const familyOf = (r) => r.species?.family?.scientificNameWithoutAuthor ?? null;

/** 엘프 판별용: 1순위의 속·과와, 후보 3개 중 같은 속 후보의 신뢰도 합. */
function genusSummary(plantnet) {
  const top = topResults(plantnet);
  const genus = top[0]?.species?.genus?.scientificNameWithoutAuthor ?? null;
  if (!genus) return null;
  const same = top.filter((r) => r.species?.genus?.scientificNameWithoutAuthor === genus);
  return {
    genus,
    family: top[0].species?.family?.scientificNameWithoutAuthor ?? null,
    confidence: roundScore(same.reduce((sum, r) => sum + (r.score ?? 0), 0)),
    candidates_in_genus: same.length,
  };
}

function sortedResults(plantnet) {
  const results = Array.isArray(plantnet?.results) ? plantnet.results : [];
  return results.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function topResults(plantnet) {
  return sortedResults(plantnet).slice(0, CANDIDATE_LIMIT);
}

function roundScore(score) {
  return typeof score === "number" ? Math.round(score * 10_000) / 10_000 : null;
}
