import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ApiError,
  MAX_PHOTO_BYTES,
  ORGANS,
  callPlantNet,
  describePlantNetRequest,
  detectImageType,
  toDetails,
  toDraftResponse,
} from "./identify.mjs";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const PAGE_ALIASES = { "/": "/index.html", "/report": "/report.html" };
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};
// public/ 아래의 알려진 확장자 파일만 내준다. 점으로 시작하는 이름과 상위 경로는 막는다.
const SAFE_PATH = /^\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_.-]*\.(html|js|css|json|jpg|svg)$/;
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

/** 서비스 전체 일일 식별 횟수 (한국 시간 기준 날짜). 서버가 다시 시작되면 0부터 센다. */
function createDailyCounter(limit, now) {
  let day = "";
  let used = 0;
  const today = () => new Date(now() + 9 * 3600_000).toISOString().slice(0, 10);
  return {
    tryTake() {
      if (today() !== day) {
        day = today();
        used = 0;
      }
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    refund() {
      if (used > 0) used -= 1;
    },
    status: () => ({ limit, used: today() === day ? used : 0 }),
  };
}

export function createApp({ apiKey, dailyLimit = 100, fetchImpl = fetch, now = Date.now, log = console } = {}) {
  const counter = createDailyCounter(dailyLimit, now);

  async function handleIdentify(req, res, url) {
    if (!apiKey) throw new ApiError(502, "IDENTIFY_FAILED", "서버에 Pl@ntNet 키가 설정되지 않았어요.");
    const organ = url.searchParams.get("organ") ?? "auto";
    if (!ORGANS.includes(organ)) throw new ApiError(400, "INVALID_PHOTO", "사진 부위 값이 올바르지 않아요.");

    const photo = await readBody(req, MAX_PHOTO_BYTES);
    const mimeType = detectImageType(photo);
    if (!mimeType) throw new ApiError(400, "INVALID_PHOTO", "JPEG·PNG·WebP 사진만 올릴 수 있어요.");

    if (!counter.tryTake()) {
      throw new ApiError(429, "DAILY_LIMIT", `오늘 테스트 한도(${dailyLimit}회)를 다 썼어요. 내일 다시 시도해 주세요.`);
    }
    const started = now();
    let plantnet;
    try {
      plantnet = await callPlantNet({ apiKey, photo, mimeType, organ, fetchImpl });
    } catch (err) {
      // Pl@ntNet이 사진을 거절한 경우는 한도를 쓰지 않은 것으로 본다
      if (err instanceof ApiError && err.status === 400) counter.refund();
      throw err;
    }
    sendJson(res, 200, {
      response: toDraftResponse(plantnet, randomUUID()),
      details: toDetails(plantnet),
      meta: {
        organ,
        photo_bytes: photo.length,
        elapsed_ms: now() - started,
        service_limit: counter.status(),
        received: { method: "POST", path: `/api/identify?organ=${organ}`, content_type: mimeType, bytes: photo.length },
        upstream: { ...describePlantNetRequest({ organ, mimeType, bytes: photo.length }), status: 200 },
      },
      plantnet_raw: plantnet,
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, { configured: Boolean(apiKey), service_limit: counter.status() });
      }
      if (url.pathname === "/api/identify") {
        if (req.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "POST로 요청해 주세요.");
        return await handleIdentify(req, res, url);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const file = await readStatic(PAGE_ALIASES[url.pathname] ?? url.pathname);
        if (file) {
          res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
          return res.end(req.method === "HEAD" ? undefined : file.body);
        }
      }
      throw new ApiError(404, "NOT_FOUND", "없는 주소예요.");
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      // 요청 URL(키 포함)이 섞일 수 있는 원본 에러는 남기지 않는다
      log.error(`[plantapi] unexpected error: ${err?.name ?? "Error"}`);
      return sendJson(res, 500, { error: { code: "INTERNAL", message: "서버 오류가 났어요." } });
    }
  };
}

async function readStatic(pathname) {
  if (!SAFE_PATH.test(pathname) || pathname.includes("..")) return null;
  try {
    const body = await readFile(fileURLToPath(new URL(`.${pathname}`, PUBLIC_DIR)));
    return { body, type: CONTENT_TYPES[pathname.slice(pathname.lastIndexOf("."))] };
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
    throw err;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      req.resume();
      return reject(new ApiError(400, "INVALID_PHOTO", "사진이 너무 커요 (최대 8MB)."));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new ApiError(400, "INVALID_PHOTO", "사진이 너무 커요 (최대 8MB)."));
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const dailyLimit = Number(process.env.IDENTIFY_DAILY_LIMIT ?? 100);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) throw new Error("IDENTIFY_DAILY_LIMIT must be a positive integer");
  const apiKey = process.env.PLANTNET_API_KEY?.trim();
  if (!apiKey) throw new Error("PLANTNET_API_KEY is required");

  const server = createServer(createApp({ apiKey, dailyLimit }));
  server.listen(port, host, () => console.log(`[plantapi] listening on http://${host}:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
