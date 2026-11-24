// 샘플 사진을 Pl@ntNet에 보내 정답과 비교하고 결과 JSON을 만든다.
// 사용법:
//   node --env-file=.env scripts/evaluate.mjs             # 위키 대표 사진 20장 → public/report/results.json
//   node --env-file=.env scripts/evaluate.mjs community   # 사용자 관찰 사진 20장 → public/report/results-community.json
//   node --env-file=.env scripts/evaluate.mjs anam        # 안암 일대 사진 20장 → public/report/results-anam.json
// 위키 사진: "자동(auto)" 1회 + 사진 부위를 직접 지정해 1회 (지정 부위가 앱 선택지에 있을 때만).
// 사용자·안암 사진: "자동(auto)" 1회. 앱과 같게 긴 변 1280px, JPEG 품질 0.7로 줄여서 보낸다 (macOS sips 사용).
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ORGANS, callPlantNet } from "../src/identify.mjs";

const SETS = {
  wiki: { manifest: "manifest.json", out: "results.json" },
  community: { manifest: "community.json", out: "results-community.json" },
  anam: { manifest: "anam.json", out: "results-anam.json" },
};
const setName = process.argv[2] ?? "wiki";
const set = SETS[setName];
if (!set) throw new Error(`unknown set "${setName}" (${Object.keys(SETS).join(" | ")})`);

const root = new URL("../", import.meta.url);
const apiKey = process.env.PLANTNET_API_KEY?.trim();
if (!apiKey) throw new Error("PLANTNET_API_KEY is required (node --env-file=.env ...)");

const manifest = JSON.parse(await readFile(new URL(`public/samples/${set.manifest}`, root), "utf8"));
const norm = (s) => (s ?? "").toLowerCase().replace(/×/g, "x").replace(/\s+/g, " ").trim();
const tmp = await mkdtemp(join(tmpdir(), "plantapi-eval-"));

function grade(sample, candidates) {
  const names = [sample.scientific_name, ...(sample.synonyms ?? [])].map(norm);
  const top = candidates[0];
  return {
    species_top1: Boolean(top && names.includes(norm(top.scientific_name))),
    species_top3: candidates.some((c) => names.includes(norm(c.scientific_name))),
    genus_top1: Boolean(top && norm(top.genus) === norm(sample.genus)),
    family_top1: Boolean(top && norm(top.family) === norm(sample.family)),
  };
}

// 앱처럼 긴 변 1280px, JPEG 품질 70으로 줄인다. 이미 작으면 그대로 보낸다.
async function appSizedPhoto(file) {
  const path = new URL(`public/samples/${file}`, root).pathname;
  const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const [w, h] = [...dims.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
  if (Math.max(w, h) <= 1280) return readFile(path);
  const out = join(tmp, file);
  execFileSync("sips", ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "70", path, "--out", out], { stdio: "ignore" });
  return readFile(out);
}

async function run(sample, photo, organ) {
  const started = Date.now();
  try {
    const pn = await callPlantNet({ apiKey, photo, mimeType: "image/jpeg", organ });
    const candidates = (pn.results ?? [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => ({
        scientific_name: r.species?.scientificNameWithoutAuthor ?? null,
        genus: r.species?.genus?.scientificNameWithoutAuthor ?? null,
        family: r.species?.family?.scientificNameWithoutAuthor ?? null,
        common_names: (r.species?.commonNames ?? []).slice(0, 2),
        confidence: Math.round(r.score * 10_000) / 10_000,
      }));
    return {
      organ,
      ok: true,
      elapsed_ms: Date.now() - started,
      predicted_organ: pn.predictedOrgans?.[0]?.organ ?? null,
      candidates,
      ...grade(sample, candidates),
      remaining: pn.remainingIdentificationRequests ?? null,
    };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { organ, ok: false, error: err.code, elapsed_ms: Date.now() - started, candidates: [],
      species_top1: false, species_top3: false, genus_top1: false, family_top1: false };
  }
}

const results = [];
try {
  for (const sample of manifest) {
    const photo = await appSizedPhoto(sample.file);
    const runs = [await run(sample, photo, "auto")];
    if (setName === "wiki" && ORGANS.includes(sample.organ) && sample.organ !== "auto") runs.push(await run(sample, photo, sample.organ));
    results.push({ id: sample.id, runs });
    const a = runs[0];
    console.log(`${sample.korean_name.padEnd(6)} auto → ${a.candidates[0]?.scientific_name ?? a.error} ${a.candidates[0]?.confidence ?? ""} ${a.genus_top1 ? "속O" : "속X"}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const last = results.flatMap((r) => r.runs).filter((r) => r.remaining != null).at(-1);
await writeFile(
  new URL(`public/report/${set.out}`, root),
  JSON.stringify({ tested_at: new Date().toISOString(), plantnet_remaining_after: last?.remaining ?? null, results }, null, 1),
);
console.log(`saved public/report/${set.out}`);
