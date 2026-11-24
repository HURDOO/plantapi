// 같은 사진을 후보 3개(nb-results=3)와 10개로 번갈아 보내 정확도·응답 시간·응답 크기를 비교한다.
// 사용법: node --env-file=.env scripts/compare-nb.mjs   (Pl@ntNet 120회 호출 → public/report/nb-compare.json)
// 순서 효과를 줄이려고 사진마다 3개/10개 중 먼저 보내는 쪽을 번갈아 바꾼다.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, callPlantNet } from "../src/identify.mjs";

const root = new URL("../", import.meta.url);
const apiKey = process.env.PLANTNET_API_KEY?.trim();
if (!apiKey) throw new Error("PLANTNET_API_KEY is required (node --env-file=.env ...)");
const SETS = [["anam", "anam.json"], ["user", "community.json"], ["wiki", "manifest.json"]];
const tmp = await mkdtemp(join(tmpdir(), "plantapi-nb-"));

async function appSizedPhoto(file) {
  const path = new URL(`public/samples/${file}`, root).pathname;
  const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const [w, h] = [...dims.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
  if (Math.max(w, h) <= 1280) return readFile(path);
  const out = join(tmp, file);
  execFileSync("sips", ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "70", path, "--out", out], { stdio: "ignore" });
  return readFile(out);
}

async function run(photo, nb) {
  let bytes = 0;
  // 응답 본문 크기를 재려고 fetch를 한 번 감싼다
  const fetchImpl = async (...args) => {
    const res = await fetch(...args);
    const buf = await res.arrayBuffer();
    bytes = buf.byteLength;
    return new Response(buf, { status: res.status, headers: res.headers });
  };
  const started = performance.now();
  try {
    const pn = await callPlantNet({ apiKey, photo, mimeType: "image/jpeg", organ: "auto", nbResults: nb, fetchImpl });
    return {
      nb, ok: true, elapsed_ms: Math.round(performance.now() - started), bytes,
      remaining: pn.remainingIdentificationRequests ?? null,
      candidates: (pn.results ?? []).slice().sort((a, b) => b.score - a.score).map((r) => ({
        scientific_name: r.species?.scientificNameWithoutAuthor ?? null,
        genus: r.species?.genus?.scientificNameWithoutAuthor ?? null,
        family: r.species?.family?.scientificNameWithoutAuthor ?? null,
        confidence: Math.round(r.score * 10_000) / 10_000,
      })),
    };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { nb, ok: false, error: err.code, elapsed_ms: Math.round(performance.now() - started), bytes, candidates: [] };
  }
}

const results = [];
let i = 0;
try {
  for (const [set, file] of SETS) {
    const manifest = JSON.parse(await readFile(new URL(`public/samples/${file}`, root), "utf8"));
    for (const sample of manifest) {
      const photo = await appSizedPhoto(sample.file);
      const order = i++ % 2 === 0 ? [3, 10] : [10, 3];
      const runs = {};
      for (const nb of order) runs[nb] = await run(photo, nb);
      results.push({ set, id: sample.id, first: order[0], n3: runs[3], n10: runs[10] });
      console.log(`${sample.korean_name.padEnd(6)} 3개 ${runs[3].elapsed_ms}ms ${runs[3].bytes}B · 10개 ${runs[10].elapsed_ms}ms ${runs[10].bytes}B`);
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
const last = results.flatMap((r) => [r.n3, r.n10]).filter((r) => r.remaining != null).at(-1);
await writeFile(
  new URL("public/report/nb-compare.json", root),
  JSON.stringify({ tested_at: new Date().toISOString(), plantnet_remaining_after: last?.remaining ?? null, results }, null, 1),
);
console.log("saved public/report/nb-compare.json");
