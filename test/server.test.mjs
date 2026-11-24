import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/server.mjs";

const KEY = "test-key-not-real";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PLANTNET_OK = {
  bestMatch: "Helianthus giganteus L.",
  predictedOrgans: [{ organ: "flower", score: 0.74866 }],
  remainingIdentificationRequests: 498,
  version: "2026-03-20 (7.5)",
  results: [
    {
      score: 0.35,
      species: {
        scientificNameWithoutAuthor: "Helianthus annuus",
        scientificNameAuthorship: "L.",
        genus: { scientificNameWithoutAuthor: "Helianthus" },
        family: { scientificNameWithoutAuthor: "Asteraceae" },
        commonNames: ["Sunflower"],
      },
      gbif: { id: "9206251" },
    },
    {
      score: 0.6179,
      species: {
        scientificNameWithoutAuthor: "Helianthus giganteus",
        scientificNameAuthorship: "L.",
        genus: { scientificNameWithoutAuthor: "Helianthus" },
        family: { scientificNameWithoutAuthor: "Asteraceae" },
        commonNames: ["Giant sunflower"],
      },
    },
  ],
};

async function withServer(options, fn) {
  const server = createServer(createApp({ apiKey: KEY, log: { error() {} }, ...options }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const fakePlantNet = (status, body) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, calls };
};

const post = (base, body = JPEG, query = "") =>
  fetch(`${base}/api/identify${query}`, { method: "POST", body, headers: { "Content-Type": "image/jpeg" } });

test("healthz와 정적 페이지를 돌려준다", async () => {
  await withServer({}, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /식물 식별 API 테스트/);
  });
});

test("성공 응답을 API 초안 I-1 모양으로 바꾸고 신뢰도 순으로 정렬한다", async () => {
  const pn = fakePlantNet(200, PLANTNET_OK);
  await withServer({ fetchImpl: pn.fetchImpl }, async (base) => {
    const res = await post(base, JPEG, "?organ=flower");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.response.identification_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.response.candidates[0], {
      species_id: null,
      scientific_name: "Helianthus giganteus",
      korean_name: null,
      confidence: 0.6179,
      character_id: null,
      is_collected: null,
      is_character_collected: null,
    });
    assert.equal(body.response.candidates[1].scientific_name, "Helianthus annuus");
    assert.equal(body.details.remaining_requests, 498);
    assert.equal(body.details.candidates[0].scientific_name, "Helianthus giganteus");
    assert.equal(body.details.candidates[0].genus, "Helianthus");
    assert.equal(body.meta.organ, "flower");

    const sent = pn.calls[0];
    assert.equal(new URL(sent.url).searchParams.get("api-key"), KEY);
    assert.equal(sent.init.body.get("organs"), "flower");
  });
});

test("사진이 아니거나 부위 값이 틀리면 400 INVALID_PHOTO", async () => {
  const pn = fakePlantNet(200, PLANTNET_OK);
  await withServer({ fetchImpl: pn.fetchImpl }, async (base) => {
    const notImage = await post(base, Buffer.from("hello"));
    assert.equal(notImage.status, 400);
    assert.equal((await notImage.json()).error.code, "INVALID_PHOTO");
    const badOrgan = await post(base, JPEG, "?organ=root");
    assert.equal((await badOrgan.json()).error.code, "INVALID_PHOTO");
    assert.equal(pn.calls.length, 0);
  });
});

test("Pl@ntNet 404는 404 NO_PLANT_FOUND", async () => {
  const pn = fakePlantNet(404, { message: "Species not found" });
  await withServer({ fetchImpl: pn.fetchImpl }, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NO_PLANT_FOUND");
  });
});

test("Pl@ntNet 한도 초과·서버 오류·연결 실패는 502 IDENTIFY_FAILED이고 키가 새지 않는다", async () => {
  for (const fetchImpl of [
    fakePlantNet(429).fetchImpl,
    fakePlantNet(500).fetchImpl,
    async (url) => {
      throw new TypeError(`fetch failed ${url}`);
    },
  ]) {
    await withServer({ fetchImpl }, async (base) => {
      const res = await post(base);
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.equal(JSON.parse(text).error.code, "IDENTIFY_FAILED");
      assert.ok(!text.includes(KEY));
    });
  }
});

test("서버 하루 한도를 넘으면 429 DAILY_LIMIT, 다음 날(KST) 초기화된다", async () => {
  let now = Date.parse("2026-11-24T14:00:00Z"); // KST 23:00
  const pn = fakePlantNet(200, PLANTNET_OK);
  await withServer({ fetchImpl: pn.fetchImpl, dailyLimit: 2, now: () => now }, async (base) => {
    assert.equal((await post(base)).status, 200);
    assert.equal((await post(base)).status, 200);
    const limited = await post(base);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "DAILY_LIMIT");
    assert.equal(pn.calls.length, 2);

    now += 2 * 3600_000; // KST 다음 날 01:00
    assert.equal((await post(base)).status, 200);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(status.service_limit, { limit: 2, used: 1 });
  });
});

test("Pl@ntNet이 사진을 거절하면 한도를 돌려준다", async () => {
  const pn = fakePlantNet(400, { message: "bad image" });
  await withServer({ fetchImpl: pn.fetchImpl, dailyLimit: 1 }, async (base) => {
    assert.equal((await post(base)).status, 400);
    assert.equal((await post(base)).status, 400);
    assert.equal(pn.calls.length, 2);
  });
});

test("키가 없으면 502로 알려준다", async () => {
  await withServer({ apiKey: "" }, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 502);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).configured, false);
  });
});
