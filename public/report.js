// 보고서: 정답(public/samples/*.json) + 평가 결과(public/report/*.json)로 모든 수치를 계산한다.
// 사진 묶음 세 개: 안암 일대 사진(anam.json) / 사용자 관찰 사진(community.json) — 둘 다 iNaturalist / 위키 대표 사진(manifest.json)
const $ = (id) => document.getElementById(id);
const ORGAN_LABEL = { auto: "자동", leaf: "잎", flower: "꽃", fruit: "열매", bark: "수피", habit: "전체 모습", other: "기타" };
const SETS = [
  { key: "anam", label: "안암 일대 사진", short: "안암", manifest: "/samples/anam.json", results: "/report/results-anam.json" },
  { key: "user", label: "사용자 관찰 사진", short: "사용자", manifest: "/samples/community.json", results: "/report/results-community.json" },
  { key: "wiki", label: "위키 대표 사진", short: "위키", manifest: "/samples/manifest.json", results: "/report/results.json" },
];
const getJson = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(url);
  return r.json();
});

const loaded = await Promise.all(SETS.map(async (s) => {
  const [manifest, report] = await Promise.all([getJson(s.manifest), getJson(s.results)]);
  return { ...s, manifest, report };
}));

const rows = loaded.flatMap((s) =>
  s.manifest.map((m) => {
    const r = s.report.results.find((x) => x.id === m.id);
    const auto = r.runs[0];
    const organRun = r.runs[1] ?? null;
    const outcome = auto.species_top1 ? "species" : auto.genus_top1 ? "genus" : "miss";
    return { set: s.key, m, auto, organRun, runs: r.runs, outcome, conf: auto.candidates[0]?.confidence ?? 0 };
  }),
);
const setLabel = (key) => SETS.find((s) => s.key === key).label;
const setShort = (key) => SETS.find((s) => s.key === key).short;
const ofSet = (key) => rows.filter((r) => r.set === key);
const n = rows.length;
const pct = (k, total) => `${Math.round((k / total) * 100)}%`;
const pct1 = (v) => `${(v * 100).toFixed(1)}%`;
const statsOf = (list) => ({
  n: list.length,
  family: list.filter((r) => r.auto.family_top1).length,
  genus: list.filter((r) => r.auto.genus_top1).length,
  top3: list.filter((r) => r.auto.species_top3).length,
  top1: list.filter((r) => r.auto.species_top1).length,
});
const all = statsOf(rows);
const by = Object.fromEntries(SETS.map((s) => [s.key, statsOf(ofSet(s.key))]));
const latencies = rows.flatMap((r) => r.runs.map((x) => x.elapsed_ms)).sort((a, b) => a - b);
const median = latencies[Math.floor(latencies.length / 2)];
const name = (r) => r.m.korean_name;
const topName = (r) => r.auto.candidates[0]?.scientific_name ?? "없음";
const lastRemaining = loaded
  .map((s) => s.report)
  .sort((a, b) => new Date(b.tested_at) - new Date(a.tested_at))[0].plantnet_remaining_after;

// ---------- 헤드라인 & KPI ----------
$("headline").textContent =
  `Pl@ntNet에 식물 사진 ${n}장(${SETS.map((s) => `${s.label} ${by[s.key].n}`).join(" + ")})을 보내 정답과 비교했어요. ` +
  "결론: 엘프 판별(속)은 지금 바로 써도 되고, 종은 사용자가 후보 중에서 고르게 해야 해요.";
const fmtDate = (iso) => new Date(iso).toLocaleDateString("ko-KR", { dateStyle: "long" });
const dates = [...new Set(loaded.map((s) => fmtDate(s.report.tested_at)))];
$("tested-at").textContent = `테스트: ${dates.join(", ")} · Pl@ntNet 호출 ${latencies.length}회`;

const kpi = (key) => SETS.map((s) => `${s.short} ${by[s.key][key]}`).join(" · ");
const kpis = [
  ["속 정답 (엘프 판별)", `${all.genus}/${n}`, `${pct(all.genus, n)} · ${kpi("genus")}`],
  ["종 정답 · 1순위", `${all.top1}/${n}`, `${pct(all.top1, n)} · ${kpi("top1")}`],
  ["종 정답 · 후보 3개 안", `${all.top3}/${n}`, `${pct(all.top3, n)} · ${kpi("top3")}`],
  ["응답 시간 (중앙값)", `${(median / 1000).toFixed(1)}초`, `최대 ${(latencies.at(-1) / 1000).toFixed(1)}초`],
];
$("kpis").replaceChildren(
  ...kpis.map(([label, value, sub]) => {
    const d = el("div", "kpi");
    d.append(el("p", "kpi-label", label), el("p", "kpi-value", value), el("p", "kpi-sub", sub));
    return d;
  }),
);

// ---------- 핵심 발견 ----------
const misses = rows.filter((r) => !r.auto.species_top1);
const missInTop3 = misses.filter((r) => r.auto.species_top3);
const missSameGenus = misses.filter((r) => r.auto.genus_top1);
const genusMiss = rows.filter((r) => !r.auto.genus_top1);
const wiki = ofSet("wiki");
const pairs = wiki.filter((r) => r.organRun);
// 후보 이름·순서가 같고 점수 차이가 0.001 미만이면 같은 결과로 본다 (반올림 오차)
const scoreGap = (a, b) => Math.max(...a.map((c, i) => Math.abs(c.confidence - (b[i]?.confidence ?? 0))));
const sameResult = (a, b) =>
  a.length === b.length && a.every((c, i) => c.scientific_name === b[i].scientific_name) && scoreGap(a, b) < 0.001;
const samePairs = pairs.filter((r) => sameResult(r.auto.candidates, r.organRun.candidates));
const maxGap = Math.max(0, ...pairs.map((r) => scoreGap(r.auto.candidates, r.organRun.candidates)));
const hi = rows.filter((r) => r.conf >= 0.5);
const lo = rows.filter((r) => r.conf < 0.5);
const habit = wiki.filter((r) => r.m.organ === "habit");
const close = wiki.filter((r) => r.m.organ !== "habit");
// 동아시아 종이 같은 속의 유럽·북미 종으로 나온 예 (속은 맞고 종만 틀린 경우만 센다)
const REGION_EXAMPLES = new Set(["Pinus densiflora", "Castanea crenata", "Taxus cuspidata", "Cornus kousa"]);
const regional = [...new Map(missSameGenus.filter((r) => REGION_EXAMPLES.has(r.m.scientific_name)).map((r) => [name(r), r])).values()];
const lowBy = Object.fromEntries(SETS.map((s) => [s.key, ofSet(s.key).filter((r) => r.conf < 0.5).length]));
const compareLine = (key) => SETS.map((s) => `${s.short} ${by[s.key][key]}`).join(" · ");
const genusRange = SETS.map((s) => by[s.key].genus);
const similarGenus = Math.max(...genusRange) - Math.min(...genusRange) <= 1;

const findings = [
  [
    `속은 ${n}장 중 ${all.genus}장을 맞혔어요.`,
    genusMiss.length
      ? `틀린 사진은 ${genusMiss.map((r) => `${name(r)} (${setShort(r.set)}, 1순위 ${topName(r)}${r.auto.family_top1 ? ", 과는 정답" : ""})`).join(", ")}뿐이에요. 속 → 과 순서의 엘프 판별 규칙에 잘 맞아요.`
      : "엘프 판별 규칙(속 → 과)에 잘 맞아요.",
  ],
  [
    `우리 동네(안암) 사진도 속은 ${by.anam.genus}/${by.anam.n}, 과는 ${by.anam.family}/${by.anam.n} 맞혔어요. ${similarGenus ? "속 정답은 세 묶음이 거의 같았어요." : ""}`,
    `묶음별 (각 20장) 속: ${compareLine("genus")} / 종 1순위: ${compareLine("top1")} / 종 후보 3개 안: ${compareLine("top3")}. ` +
      `다만 안암 사진은 1순위 신뢰도 50% 미만이 ${lowBy.anam}장으로 다른 묶음(${SETS.filter((s) => s.key !== "anam").map((s) => `${s.short} ${lowBy[s.key]}장`).join(", ")})보다 많았어요. ` +
      "실제 동네에서 찍은 사진은 Pl@ntNet이 덜 확신하니, 아래 '한 장 더 찍기' 단계가 자주 쓰일 거예요.",
  ],
  [
    `종을 1순위로 틀린 ${misses.length}장 중 ${missSameGenus.length}장은 같은 속의 다른 종이었어요.`,
    `${missSameGenus.map((r) => `${name(r)} → ${topName(r)}`).join(", ")}. 이 중 ${missInTop3.length}장은 후보 3개 안에 정답이 있었어요. 후보를 보여주고 고르게 하는 초안 설계가 맞아요.` +
      (regional.length ? ` 특히 ${regional.map(name).join("·")}는 동아시아 종인데 같은 속의 유럽·북미 종으로 나왔어요.` : ""),
  ],
  [
    `신뢰도 50% 이상이면 종 정답이 ${hi.filter((r) => r.auto.species_top1).length}/${hi.length}, 50% 미만이면 ${lo.filter((r) => r.auto.species_top1).length}/${lo.length}였어요.`,
    `50% 미만에서도 속은 ${lo.filter((r) => r.auto.genus_top1).length}/${lo.length}장 맞았어요. 이때는 종 결과를 그대로 믿기보다 후보 중에서 고르게 하거나 다시 찍도록 안내하는 게 좋아요.`,
  ],
  [
    `사진 부위를 지정해도 결과가 ${pairs.length}장 중 ${samePairs.length}장에서 같았어요 (위키 사진).`,
    `후보와 순서가 같았고, 점수 차이는 가장 커도 ${maxGap.toFixed(4)}였어요. 단풍잎 사진에 일부러 '수피'를 줘도 똑같았어요. 현재 Pl@ntNet 모델(7.5)은 부위 값을 결과에 쓰지 않는 것 같아요. 회의 안건 'organ 입력' → 넣지 않아도 돼요.`,
  ],
  [
    `나무 전체를 찍은 위키 사진 ${habit.length}장은 종 정답이 ${habit.filter((r) => r.auto.species_top1).length}장이었어요. 잎·꽃을 가까이 찍은 ${close.length}장은 ${close.filter((r) => r.auto.species_top1).length}장이었어요.`,
    "촬영 화면에 '잎이나 꽃을 가까이' 가이드를 넣으면 도움이 돼요.",
  ],
  [
    `응답은 빨라요. 중앙값 ${(median / 1000).toFixed(1)}초, 가장 느린 요청도 ${(latencies.at(-1) / 1000).toFixed(1)}초였어요.`,
    `마지막 테스트 후 Pl@ntNet 남은 하루 요청은 ${lastRemaining ?? "-"}회예요 (무료 키 하루 500회).`,
  ],
];
$("findings").replaceChildren(
  ...findings.map(([title, body]) => {
    const li = el("li", "");
    li.append(el("p", "finding-title", title), el("p", "finding-body", body));
    return li;
  }),
);

// ---------- 신뢰도별 화면 구성 (속 신뢰도 = 1순위와 같은 속인 후보 점수 합) ----------
const genusConf = (r) => {
  const c = r.auto.candidates;
  return c.length ? c.filter((x) => x.genus === c[0].genus).reduce((s, x) => s + x.confidence, 0) : 0;
};
const TIERS = [
  {
    key: "high", label: "1순위 미리 선택", range: "속 신뢰도 70% 이상", test: (g) => g >= 0.7, tone: "good",
    screen: "1순위 종을 미리 골라 둔 후보 카드를 보여줘요. 사용자는 \"맞아요\"만 누르면 돼요.",
  },
  {
    key: "mid", label: "후보 나란히", range: "50~70%", test: (g) => g >= 0.5 && g < 0.7, tone: "warn",
    screen: "\"이 식물이 맞나요?\"로 후보 3개를 나란히 보여주고 고르게 해요.",
  },
  {
    key: "low", label: "한 장 더 찍기 권유", range: "50% 미만", test: (g) => g < 0.5, tone: "bad",
    screen: "후보와 함께 \"잎이나 꽃을 가까이 한 장 더\" 버튼을 먼저 보여줘요. 엘프 판정이 보류된 경우도 여기서 다시 찍어요.",
  },
];
const tierRows = TIERS.map((t) => {
  const list = rows.filter((r) => t.test(genusConf(r)));
  return { ...t, list, genusOk: list.filter((r) => r.auto.genus_top1).length, top1: list.filter((r) => r.auto.species_top1).length };
});
$("tiers").replaceChildren(
  ...tierRows.map((t) => {
    const card = el("div", `tier ${t.tone}`);
    const head = el("div", "tier-head");
    head.append(el("p", "tier-label", t.label), el("p", "tier-range", t.range));
    const stat = el("p", "tier-stat");
    stat.append(
      el("strong", "", `${t.list.length}장`),
      document.createTextNode(` (${pct(t.list.length, n)}) · 속 정답 ${t.genusOk}/${t.list.length} · 종 1순위 ${t.top1}/${t.list.length}`),
    );
    const miss = t.list.filter((r) => !r.auto.genus_top1).map(name);
    card.append(head, stat, el("p", "tier-screen", t.screen));
    if (miss.length) card.append(el("p", "hint", `속이 틀린 사진: ${miss.join(", ")}`));
    return card;
  }),
);

// ---------- 엘프 판정 단계 (서버 src/identify.mjs elfDecision과 같은 규칙) + 후보 3개 vs 10개 ----------
const nbCompare = await getJson("/report/nb-compare.json");
const truthById = new Map(rows.map((r) => [r.m.id, r]));
const norm = (s) => (s ?? "").toLowerCase().replace(/×/g, "x").replace(/\s+/g, " ").trim();
function elfDecision(cands) {
  if (!cands.length) return { level: "retake" };
  const sumBy = (key) => {
    const m = new Map();
    for (const c of cands) m.set(c[key], (m.get(c[key]) ?? 0) + c.confidence);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const genera = sumBy("genus");
  const families = sumBy("family");
  const total = cands.reduce((s, c) => s + c.confidence, 0);
  const ratio = genera.length > 1 && genera[1][1] > 0 ? genera[0][1] / genera[1][1] : null;
  if (genera[0][0] === cands[0].genus && (ratio === null || ratio >= 2)) return { level: "genus", value: cands[0].genus, ratio };
  if (families[0][1] / total >= 0.8) return { level: "family", value: families[0][0], ratio, share: families[0][1] / total };
  return { level: "retake", ratio };
}
const nbRows = nbCompare.results.map((x) => {
  const r = truthById.get(x.id);
  const judge = (run) => {
    const d = elfDecision(run.candidates);
    const ok = d.level === "genus" ? norm(d.value) === norm(r.m.genus) : d.level === "family" ? norm(d.value) === norm(r.m.family) : null;
    const names = [r.m.scientific_name, ...(r.m.synonyms ?? [])].map(norm);
    return {
      d, ok,
      species: run.candidates.some((c) => names.includes(norm(c.scientific_name))),
      genusIn: run.candidates.some((c) => norm(c.genus) === norm(r.m.genus)),
      speciesRank: run.candidates.findIndex((c) => names.includes(norm(c.scientific_name))) + 1,
    };
  };
  return { r, x, n3: judge(x.n3), n10: judge(x.n10) };
});
const LEVELS = [
  ["genus", "속으로 정함", "good"],
  ["family", "과로 정함", "warn"],
  ["retake", "판정 보류 · 한 장 더", "bad"],
];
$("elf-levels").replaceChildren(
  ...LEVELS.map(([key, label, tone]) => {
    const list = nbRows.filter((x) => x.n10.d.level === key);
    const card = el("div", `tier ${tone}`);
    const head = el("div", "tier-head");
    head.append(el("p", "tier-label", label));
    const stat = el("p", "tier-stat");
    const okN = list.filter((x) => x.n10.ok).length;
    stat.append(el("strong", "", `${list.length}장`), document.createTextNode(key === "retake" ? ` (${pct(list.length, n)})` : ` (${pct(list.length, n)}) · 정답 ${okN}/${list.length}`));
    card.append(head, stat);
    if (key !== "genus" && list.length) card.append(el("p", "tier-screen", list.map((x) => `${name(x.r)}${key === "family" ? ` → ${x.n10.d.value}` : ""}`).join(", ")));
    const wrong = list.filter((x) => x.n10.ok === false).map((x) => `${name(x.r)} → ${x.n10.d.value}`);
    if (wrong.length) card.append(el("p", "hint", `틀린 판정: ${wrong.join(", ")}`));
    return card;
  }),
);
const decidedWrong = nbRows.filter((x) => x.n10.ok === false);
$("elf-note").textContent = decidedWrong.length
  ? `틀린 ${decidedWrong.length}장(${decidedWrong.map((x) => name(x.r)).join(", ")})은 Pl@ntNet이 다른 속을 크게 확신한 경우라 점수로는 못 잡아요. 촬영 가이드와 사용자의 종 확정 단계에서 걸러야 해요. 규칙 기준(2배·80%)은 60장으로 만든 가설이라 더 많은 사진으로 확인해야 해요.`
  : "규칙 기준(2배·80%)은 60장으로 만든 가설이라 더 많은 사진으로 확인해야 해요.";

const q = (arr, p) => {
  const v = arr.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
};
const runsOf = (nb) => nbCompare.results.map((x) => x[nb]);
const msStat = (nb) => runsOf(nb).map((r) => r.elapsed_ms);
const sec = (ms) => `${(ms / 1000).toFixed(2)}초`;
const sameTop3 = nbCompare.results.filter((x) =>
  x.n3.candidates.every((c, i) => c.scientific_name === x.n10.candidates[i]?.scientific_name && Math.abs(c.confidence - x.n10.candidates[i].confidence) < 0.002)).length;
const cnt = (nb, f) => nbRows.filter((x) => f(x[nb])).length;
const decidedOk = (nb) => `${cnt(nb, (j) => j.ok === true)}/${cnt(nb, (j) => j.ok !== null)} (보류 ${cnt(nb, (j) => j.ok === null)})`;
const pairedDiff = nbCompare.results.map((x) => x.n10.elapsed_ms - x.n3.elapsed_ms);
const median3 = q(msStat("n3"), 0.5), median10 = q(msStat("n10"), 0.5);
const tableRows = [
  ["항목", "후보 3개", "후보 10개"],
  ["상위 3개 결과", `${sameTop3}/${nbCompare.results.length} 같음`, "같음"],
  ["정답 종이 후보 안에", `${cnt("n3", (j) => j.species)}/${n}`, `${cnt("n10", (j) => j.species)}/${n}`],
  ["정답 속이 후보 안에", `${cnt("n3", (j) => j.genusIn)}/${n}`, `${cnt("n10", (j) => j.genusIn)}/${n}`],
  ["엘프 판정(속·과) 정답", decidedOk("n3"), decidedOk("n10")],
  ["응답 시간 · 중앙값", sec(median3), sec(median10)],
  ["응답 시간 · 90%", sec(q(msStat("n3"), 0.9)), sec(q(msStat("n10"), 0.9))],
  ["응답 크기 · 중앙값", `${(q(runsOf("n3").map((r) => r.bytes), 0.5) / 1024).toFixed(1)}KB`, `${(q(runsOf("n10").map((r) => r.bytes), 0.5) / 1024).toFixed(1)}KB`],
  ["Pl@ntNet 하루 한도 차감", "1회", "1회"],
];
$("nb-table").replaceChildren(
  ...tableRows.map((cells, i) => {
    const tr = el("tr", "");
    cells.forEach((c, j) => tr.append(el(i === 0 || j === 0 ? "th" : "td", "", c)));
    return tr;
  }),
);
const gained = nbRows.filter((x) => !x.n3.species && x.n10.species);
const slower = pairedDiff.filter((d) => d > 0).length;
$("nb-notes").replaceChildren(
  ...[
    [`10개로 늘려도 상위 3개는 그대로예요.`, " 점수도 같아서 지금 화면·정확도는 바뀌지 않아요. 엘프 판정 규칙도 3개만으로 같은 결과가 나왔어요."],
    [`4~10위에서 정답 종이 ${gained.length}장 더 나왔어요.`, ` ${gained.map((x) => `${name(x.r)}(${x.n10.speciesRank}위)`).join(", ")}. DB에서 한국 종을 찾아 올려 줄 때 쓸 재료가 생겨요.`],
    [`대신 조금 느려요.`, ` 같은 사진끼리 비교하면 10개가 ${slower}/${pairedDiff.length}장에서 더 느렸고, 중앙값 차이는 ${Math.round(q(pairedDiff, 0.5))}ms예요. 가끔 2초 넘게 걸리는 경우도 10개 쪽에 더 많았어요. 응답 크기(약 3KB 차이)와 요청 한도는 문제없어요.`],
    ["결론: Pl@ntNet에는 10개를 요청하고, 화면·I-1 응답에는 3개만 보여줘요.", " 테스트 서버도 이렇게 바꿨어요 (4~10위는 결과 카드에서 접어서 볼 수 있어요)."],
  ].map(([b, t]) => {
    const li = el("li", "");
    li.append(el("b", "", b), document.createTextNode(t));
    return li;
  }),
);

// ---------- 한눈에 보기 ----------
const [tHigh, tMid, tLow] = tierRows;
const tldr = [
  ["엘프 판별(속)은 Pl@ntNet으로 충분해요.",
    `${n}장 중 ${all.genus}장(${pct(all.genus, n)}) 정답. 우리 동네인 안암 일대 사진도 ${by.anam.genus}/${by.anam.n}, 과까지 보면 ${by.anam.family}/${by.anam.n}이에요.`],
  ["종은 1순위만 믿으면 안 돼요. 후보 중에서 사용자가 고르게 해요.",
    `1순위 정답 ${all.top1}/${n}(${pct(all.top1, n)}), 후보 3개 안 ${all.top3}/${n}(${pct(all.top3, n)}). 틀린 종도 대부분 같은 속이라 엘프는 맞아요.`],
  ["엘프는 점수 모양을 보고 속 · 과 · 보류 중에서 정해요.",
    `1위 속이 2위 속의 2배 이상이면 속(${nbRows.filter((x) => x.n10.d.level === "genus").length}장), 속은 갈리고 한 과가 80% 이상이면 과(${nbRows.filter((x) => x.n10.d.level === "family").length}장, 밀·호밀 → 벼과), 둘 다 아니면 한 장 더(${nbRows.filter((x) => x.n10.d.level === "retake").length}장). 판정한 ${nbRows.filter((x) => x.n10.ok !== null).length}장 중 ${nbRows.filter((x) => x.n10.ok).length}장 정답이에요.`],
  ["종 후보 화면은 속 신뢰도로 3단계로 나눠요.",
    `70% 이상 ${tHigh.list.length}장은 속이 ${tHigh.genusOk}/${tHigh.list.length} 정답이라 1순위를 미리 골라 두고, 50~70% ${tMid.list.length}장은 후보를 나란히 보여주고, 50% 미만 ${tLow.list.length}장은 한 장 더 찍기를 권해요.`],
  ["한국 이름은 식별 직후 백그라운드에서 채우고 후보 화면에 실시간 반영해요.",
    "DB에 없는 종도 응답을 기다리게 하지 않아요. 번역 중에는 \"OO속 식물\"로 보여주고, 저장은 species_id로 바로 해요."],
  ["정확도는 촬영 가이드와 한국 종 DB 매칭으로 먼저 올려요.",
    `Pl@ntNet에는 후보를 10개 요청해요 (4~10위에서 정답 종 ${nbRows.filter((x) => !x.n3.species && x.n10.species).length}장 추가, 응답 중앙값 +${Math.round(q(pairedDiff, 0.5))}ms, 한도 차감 같음). 사진 부위(organ) 선택은 효과가 없어 넣지 않아요.`],
];
$("tldr").replaceChildren(
  ...tldr.map(([title, body]) => {
    const li = el("li", "");
    li.append(el("p", "tldr-title", title), el("p", "tldr-body", body));
    return li;
  }),
);

// 본문 안 숫자 채우기
const inline = {
  top1: `${all.top1}/${n}(${pct(all.top1, n)})`,
  top3: `${all.top3}/${n}(${pct(all.top3, n)})`,
  median: `${(median / 1000).toFixed(1)}초`,
  gain: `${nbRows.filter((x) => !x.n3.species && x.n10.species).length}장`,
  habit: `전체 모습 ${habit.filter((r) => r.auto.species_top1).length}/${habit.length}, 잎·꽃 근접 ${close.filter((r) => r.auto.species_top1).length}/${close.length}`,
};
for (const node of document.querySelectorAll("[data-k]")) node.textContent = inline[node.dataset.k] ?? "";

// ---------- 차트 1: 단계별 정답률 (묶음별 막대 2개) ----------
$("levels-legend").replaceChildren(
  ...SETS.map((s) => {
    const item = el("span", "legend-item");
    item.append(el("span", `swatch set-${s.key}`), document.createTextNode(`${s.label} ${by[s.key].n}장`));
    return item;
  }),
);
const levels = [
  ["과", "family", (r) => !r.auto.family_top1],
  ["속 (엘프)", "genus", (r) => !r.auto.genus_top1],
  ["종 · 후보 3개 안", "top3", (r) => !r.auto.species_top3],
  ["종 · 1순위", "top1", (r) => !r.auto.species_top1],
];
const levelChart = el("div", "hbars grouped");
for (const [label, key, missPred] of levels) {
  const group = el("div", `hbar-group${key === "genus" ? " is-key" : ""}`);
  group.append(el("p", "hbar-group-label", label));
  for (const s of SETS) {
    const st = by[s.key];
    const k = st[key];
    const row = el("div", "hbar");
    const track = el("div", "hbar-track");
    const fill = el("span", `hbar-fill set-${s.key}`);
    fill.style.width = `${(k / st.n) * 100}%`;
    track.append(fill);
    const value = el("span", "hbar-value", `${k}/${st.n} `);
    value.append(el("small", "", pct(k, st.n)));
    row.append(el("span", "hbar-label", s.short), track, value);
    row.tabIndex = 0;
    row.setAttribute("aria-label", `${label} ${s.label} ${k}/${st.n}`);
    const missed = ofSet(s.key).filter(missPred).map(name);
    bindTooltip(row, () => [[`${k}/${st.n} (${pct(k, st.n)})`, `${label} · ${s.label}`], ["틀린 사진", missed.length ? missed.join(", ") : "없음"]]);
    group.append(row);
  }
  levelChart.append(group);
}
$("chart-levels").append(levelChart);

// ---------- 차트 2: 신뢰도 × 결과 ----------
const OUTCOMES = [
  ["species", "✓ 종까지 정답", "var(--good)"],
  ["genus", "△ 속만 정답", "var(--warning)"],
  ["miss", "✗ 오답", "var(--critical)"],
];
$("dots-legend").replaceChildren(
  ...OUTCOMES.map(([, label, color]) => {
    const item = el("span", "legend-item");
    const sw = el("span", "swatch round");
    sw.style.background = color;
    item.append(sw, document.createTextNode(label));
    return item;
  }),
  ...SETS.map((s) => {
    const item = el("span", "legend-item");
    item.append(el("span", `shape shape-${s.key}`), document.createTextNode(s.label));
    return item;
  }),
);
let resizeTimer;
let lastWidth = 0;
drawConfidence();
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($("chart-confidence").clientWidth !== lastWidth) drawConfidence();
  }, 150);
});

function drawConfidence() {
  // 실제 폭으로 그려서 좁은 화면에서도 글자가 작아지지 않게 한다
  const W = Math.max(280, $("chart-confidence").clientWidth);
  lastWidth = W;
  const narrow = W < 480;
  const rowH = 96, top = 8, left = narrow ? 96 : 118, right = 18, axisH = 28;
  const H = top + rowH * OUTCOMES.length + axisH;
  const x = (v) => left + v * (W - left - right);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "dots", role: "img", "aria-label": "1순위 신뢰도와 정답 여부 점 차트" });

  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl("line", { x1: x(t), x2: x(t), y1: top, y2: top + rowH * OUTCOMES.length, class: t === 0.5 ? "threshold" : "grid" }));
    const label = svgEl("text", { x: x(t), y: H - 8, class: "axis", "text-anchor": t === 0 ? "start" : t === 1 ? "end" : "middle" });
    label.textContent = narrow && (t === 0.25 || t === 0.75) ? "" : `${t * 100}%`;
    svg.append(label);
  }

  OUTCOMES.forEach(([key, label, color], i) => {
    const cy = top + rowH * i + rowH / 2;
    const items = rows.filter((r) => r.outcome === key).sort((a, b) => a.conf - b.conf);
    const t = svgEl("text", { x: 0, y: cy + 4, class: "row-label" });
    t.textContent = `${narrow ? label.replace(" 정답", "") : label} ${items.length}`;
    svg.append(t);
    // 가까운 점은 위아래 여러 줄로 비켜 겹침을 줄인다
    const lanes = [0, -12, 12, -24, 24, -36, 36];
    const laneEnd = lanes.map(() => -99);
    for (const r of items) {
      const px = x(r.conf);
      let lane = lanes.findIndex((_, j) => px - laneEnd[j] >= 14);
      if (lane < 0) lane = 0;
      laneEnd[lane] = px;
      const py = cy + lanes[lane];
      const g = svgEl("g", { class: "dot", tabindex: 0, role: "button", "aria-label": `${name(r)} (${setShort(r.set)}) ${pct1(r.conf)}` });
      // 모양으로 사진 묶음을 구분한다: 안암 ▲, 사용자 ●, 위키 ■
      const mark = r.set === "user"
        ? svgEl("circle", { cx: px, cy: py, r: 6.5, fill: color, class: "mark" })
        : r.set === "anam"
          ? svgEl("path", { d: `M${px} ${py - 8}L${px + 7.5} ${py + 5.5}H${px - 7.5}Z`, fill: color, class: "mark" })
          : svgEl("rect", { x: px - 6, y: py - 6, width: 12, height: 12, rx: 2, fill: color, class: "mark" });
      g.append(svgEl("circle", { cx: px, cy: py, r: 14, class: "hit" }), mark);
      bindTooltip(g, () => [
        [pct1(r.conf), `${name(r)} · 1순위 신뢰도`],
        [setShort(r.set), setLabel(r.set)],
        ["1순위", topName(r)],
        ["정답", r.m.scientific_name],
      ]);
      svg.append(g);
    }
  });
  $("chart-confidence").replaceChildren(svg);
}

// ---------- 사진별 결과 ----------
const grid = $("photo-grid");
for (const r of rows) grid.append(photoCard(r));
const filters = { set: "all", outcome: "all" };
function applyFilters() {
  let shown = 0;
  for (const card of grid.children) {
    card.hidden = (filters.set !== "all" && card.dataset.set !== filters.set) ||
      (filters.outcome !== "all" && card.dataset.outcome !== filters.outcome);
    if (!card.hidden) shown += 1;
  }
  $("grid-count").textContent = `${shown}장`;
}
for (const [attr, key] of [["set", "set"], ["filter", "outcome"]]) {
  const buttons = document.querySelectorAll(`[data-${attr}]`);
  for (const b of buttons) {
    b.addEventListener("click", () => {
      for (const o of buttons) o.setAttribute("aria-pressed", String(o === b));
      filters[key] = b.dataset[attr];
      applyFilters();
    });
  }
}
applyFilters();

function photoCard(r) {
  const li = el("li", "photo card-lite");
  li.dataset.outcome = r.outcome;
  li.dataset.set = r.set;
  const img = el("img", "photo-img");
  img.src = `/samples/thumb/${r.m.file}`;
  img.alt = `${r.m.korean_name} 사진`;
  img.loading = "lazy";
  const [, outcomeLabel] = OUTCOMES.find(([k]) => k === r.outcome);
  const head = el("div", "photo-head");
  const title = el("div", "");
  const sci = el("p", "photo-sci");
  sci.append(el("i", "", r.m.scientific_name));
  const nameLine = el("p", "photo-name", `${r.m.korean_name} `);
  nameLine.append(el("span", `set-tag ${r.set}`, setShort(r.set)));
  title.append(nameLine, sci);
  head.append(title, el("span", `chip ${r.outcome === "species" ? "good" : r.outcome === "genus" ? "warn" : "bad"}`, outcomeLabel));

  const top = r.auto.candidates[0];
  const genusLine = el("div", `photo-genus ${r.auto.genus_top1 ? "ok" : "no"}`);
  const gName = el("p", "");
  gName.append(el("span", "photo-genus-label", "속 (엘프)"), el("i", "", top?.genus ?? "없음"));
  genusLine.append(gName, el("span", "photo-genus-mark", r.auto.genus_top1 ? "✓ 정답" : `✗ 정답 ${r.m.genus}`));
  const result = el("p", "photo-result");
  result.append(document.createTextNode("종 1순위 "), el("i", "", top?.scientific_name ?? "없음"), document.createTextNode(` · ${top ? pct1(top.confidence) : "-"}`));

  const checks = el("div", "checks");
  const mark = (label, ok) => el("span", `check ${ok ? "ok" : "no"}`, `${ok ? "✓" : "✗"} ${label}`);
  checks.append(mark("과", r.auto.family_top1), mark("종 1순위", r.auto.species_top1), mark("종 3순위 안", r.auto.species_top3));

  const meta = el("p", "hint", [
    r.m.location ? `📍 ${r.m.location}` : null,
    r.m.reference ? `정답 기준: ${r.m.reference}` : null,
    r.m.organ ? `사진: ${ORGAN_LABEL[r.m.organ] ?? r.m.organ}` : null,
    r.auto.predicted_organ ? `Pl@ntNet 판단: ${ORGAN_LABEL[r.auto.predicted_organ] ?? r.auto.predicted_organ}` : null,
    r.organRun ? (sameResult(r.organRun.candidates, r.auto.candidates) ? "부위 지정해도 동일" : "부위 지정 시 달라짐") : null,
  ].filter(Boolean).join(" · "));

  const more = el("details", "photo-more");
  more.append(el("summary", "", "후보 3개 보기"));
  const ol = el("ol", "mini-cands");
  for (const c of r.auto.candidates) {
    const item = el("li", "");
    item.append(el("i", "", c.scientific_name), document.createTextNode(` ${pct1(c.confidence)} · ${c.genus} · ${c.family}`));
    ol.append(item);
  }
  more.append(ol);
  if (r.m.note) more.append(el("p", "hint", r.m.note));

  const go = el("a", "btn small", "이 사진으로 테스트");
  go.href = `/?sample=${encodeURIComponent(r.m.id)}`;

  const body = el("div", "photo-body");
  body.append(head, genusLine, result, checks, meta, more, go);
  li.append(img, body);
  return li;
}

// ---------- 출처 ----------
for (const s of loaded) {
  $(`credit-list-${s.key}`).replaceChildren(
    ...s.manifest.map((m) => {
      const li = el("li", "");
      const src = el("a", "", m.korean_name);
      src.href = m.credit.source;
      src.rel = "noopener";
      li.append(src, document.createTextNode(` — ${m.location ? `${m.location} · ` : ""}${m.credit.artist || "작가 미상"} · `));
      if (m.credit.license_url) {
        const lic = el("a", "", m.credit.license);
        lic.href = m.credit.license_url;
        lic.rel = "noopener license";
        li.append(lic);
      } else li.append(document.createTextNode(m.credit.license));
      return li;
    }),
  );
}

// ---------- 툴팁 ----------
function bindTooltip(target, lines) {
  const tip = $("tooltip");
  const show = (clientX, clientY) => {
    tip.replaceChildren(
      ...lines().map(([value, label]) => {
        const row = el("div", "tip-row");
        row.append(el("strong", "", value), el("span", "", label));
        return row;
      }),
    );
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, clientX + 12));
    const topY = clientY - height - 12 < 8 ? clientY + 16 : clientY - height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${topY}px`;
  };
  const hide = () => (tip.hidden = true);
  target.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
  target.addEventListener("pointerdown", (e) => show(e.clientX, e.clientY));
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", () => {
    const b = target.getBoundingClientRect();
    show(b.left + b.width / 2, b.top);
  });
  target.addEventListener("blur", hide);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
