// 사진을 넣는 즉시 앱 규칙(긴 변 1280px, JPEG 0.7)으로 줄여 /api/identify에 보낸다.
// 여러 장이면 한 장씩 차례로 보낸다 (Pl@ntNet 동시 요청 제한 보호).
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.7;
const ORGAN_LABEL = { auto: "자동", leaf: "잎", flower: "꽃", fruit: "열매", bark: "수피", habit: "전체 모습", other: "기타" };

const $ = (id) => document.getElementById(id);
const queue = [];
let running = false;

// ---------- 입력 ----------
for (const input of [$("camera"), $("gallery")]) {
  input.addEventListener("change", () => {
    addFiles([...(input.files ?? [])]);
    input.value = "";
  });
}
$("drop").addEventListener("click", (e) => {
  if (!e.target.closest("label")) $("gallery").click();
});
$("drop").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("gallery").click();
  }
});
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth += 1;
  $("drag-veil").hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("drag-veil").hidden = true;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drag-veil").hidden = true;
  addFiles([...e.dataTransfer.files]);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) addFiles(files);
});
$("clear").addEventListener("click", () => {
  for (const li of $("results").querySelectorAll("li")) URL.revokeObjectURL(li.dataset.preview ?? "");
  $("results").replaceChildren();
  syncEmpty();
});

function hasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

function addFiles(files) {
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  for (const file of images) enqueue({ source: file, name: file.name || "붙여넣은 사진" });
  if (images.length < files.length) toast("사진이 아닌 파일은 건너뛰었어요.");
}

// ---------- 샘플 ----------
loadSamples();
loadReportTeaser();
async function loadSamples() {
  const [anam, community, report] = await Promise.all([
    loadSampleStrip("anam.json", "anam-sample-strip"),
    loadSampleStrip("community.json", "community-sample-strip"),
    loadSampleStrip("manifest.json", "sample-strip"),
  ]);
  showSampleCredits("anam", anam);
  showSampleCredits("community", community);
  const wanted = new URLSearchParams(location.search).get("sample");
  const hit = [...anam, ...community, ...report].find((s) => s.id === wanted);
  if (hit) runSample(hit);
}

async function loadSampleStrip(manifest, stripId) {
  const strip = $(stripId);
  let samples;
  try {
    const response = await fetch(`/samples/${manifest}`);
    if (!response.ok) throw new Error("Samples unavailable");
    samples = await response.json();
  } catch {
    strip.append(el("p", "hint", "샘플 목록을 불러오지 못했어요."));
    return [];
  }
  for (const s of samples) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample";
    b.title = [`${s.korean_name} (${s.scientific_name})`, s.location].filter(Boolean).join(" · ");
    const img = document.createElement("img");
    img.src = `/samples/thumb/${s.file}`;
    img.alt = "";
    img.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = s.korean_name;
    b.append(img, label);
    b.addEventListener("click", () => runSample(s));
    strip.append(b);
  }
  return samples;
}

function showSampleCredits(group, samples) {
  if (!samples.length) return;
  const list = $(`${group}-credit-list`);
  for (const { korean_name, location, credit } of samples) {
    const item = el("li", "");
    const photo = el("a", "", korean_name);
    photo.href = credit.photo;
    const observation = el("a", "", "관찰 기록");
    observation.href = credit.source;
    const license = el("a", "", credit.license);
    license.href = credit.license_url;
    const attribution = [location, credit.artist].filter(Boolean).join(" · ");
    item.append(photo, document.createTextNode(` · ${attribution} · `), license, document.createTextNode(" · "), observation);
    list.append(item);
  }
  $(`${group}-credits`).hidden = false;
}

async function loadReportTeaser() {
  try {
    const sets = await Promise.all(["/report/results-anam.json", "/report/results-community.json", "/report/results.json"].map(async (url) => (await (await fetch(url)).json()).results));
    const auto = sets.flat().map((r) => r.runs[0]);
    const anam = sets[0].map((r) => r.runs[0]);
    const k = (list, key) => list.filter((r) => r[key]).length;
    $("report-teaser").textContent =
      `속(엘프) 정답 ${k(auto, "genus_top1")}/${auto.length} · 종 1순위 ${k(auto, "species_top1")}/${auto.length} · ` +
      `안암 일대 사진만 보면 속 ${k(anam, "genus_top1")}/${anam.length}`;
  } catch {
    // 요약을 못 불러와도 링크는 그대로 쓴다
  }
}

async function runSample(sample) {
  try {
    const response = await fetch(`/samples/${sample.file}`);
    if (!response.ok) throw new Error("Sample unavailable");
    const blob = await response.blob();
    enqueue({ source: blob, name: `샘플 · ${sample.korean_name}`, sample });
  } catch {
    toast("샘플 사진을 불러오지 못했어요.");
  }
}

// ---------- 처리 ----------
function enqueue(job) {
  job.organ = document.querySelector('input[name="organ"]:checked').value;
  job.card = createCard(job);
  queue.push(job);
  scrollToResults();
  pump();
}

// 사진을 넣으면 결과 카드로 내려간다. 여러 장을 한 번에 넣어도 한 번만, 맨 위(새) 카드로 스크롤한다.
// 결과가 나오기 전에는 페이지가 짧아 카드가 화면 중간에 멈출 수 있어, 결과가 나오면 한 번 더 맞춘다
// (그 사이 사용자가 직접 스크롤했으면 건드리지 않는다).
let scrollPending = false;
let autoScroll = null; // { card, userMoved }
function scrollToResults() {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    const card = $("results").firstElementChild;
    if (!card) return;
    autoScroll = { card, userMoved: false };
    card.scrollIntoView({ behavior: smoothOrNot(), block: "start" });
    // 부드러운 스크롤이 끝난 뒤부터 사용자 입력을 본다
    const watch = () => { if (autoScroll?.card === card) autoScroll.userMoved = true; };
    setTimeout(() => {
      for (const type of ["wheel", "touchmove", "keydown"]) window.addEventListener(type, watch, { once: true, passive: true });
    }, 800);
  });
}
function rescrollIfFollowing(card) {
  if (autoScroll?.card !== card || autoScroll.userMoved) return;
  autoScroll = null;
  requestAnimationFrame(() => card.scrollIntoView({ behavior: smoothOrNot(), block: "start" }));
}
const smoothOrNot = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    await process(job);
    rescrollIfFollowing(job.card);
  }
  running = false;
  loadQuota();
}

async function process(job) {
  setChip(job.card, "busy", "식별 중…");
  let shrunk;
  try {
    shrunk = await shrink(job.source);
    job.card.querySelector(".result-thumb").src = job.card.dataset.preview = URL.createObjectURL(shrunk.blob);
  } catch {
    return showError(job, "INVALID_PHOTO", "이 사진을 읽지 못했어요. JPEG나 PNG로 다시 시도해 주세요.");
  }
  job.input = {
    path: `/api/identify?organ=${job.organ}`,
    original: `${job.source.type || "알 수 없는 형식"}, ${size(job.source.size)}`,
    sent: `JPEG ${shrunk.width}×${shrunk.height}, ${size(shrunk.blob.size)}`,
  };
  try {
    const res = await fetch(job.input.path, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: shrunk.blob,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return showError(job, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? "요청에 실패했어요.", res.status, body);
    }
    renderSuccess(job, body);
  } catch {
    showError(job, "NETWORK", "서버에 연결하지 못했어요.");
  }
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", JPEG_QUALITY),
  );
  return { blob, width: canvas.width, height: canvas.height };
}

// ---------- 렌더링 ----------
function createCard(job) {
  const li = $("result-tpl").content.firstElementChild.cloneNode(true);
  li.querySelector(".result-name").textContent = job.name;
  li.querySelector(".result-sub").textContent = job.organ === "auto" ? "대기 중" : `부위 지정: ${ORGAN_LABEL[job.organ]}`;
  $("results").prepend(li);
  syncEmpty();
  return li;
}

function renderSuccess(job, result) {
  const { response, details, meta } = result;
  const card = job.card;
  const g = details.genus_summary;
  setChip(card, g ? confidenceTone(g.confidence) : "warn", g ? `속 ${g.genus}` : "후보 없음");
  card.querySelector(".result-sub").textContent = [
    `${(meta.elapsed_ms / 1000).toFixed(1)}초`,
    details.predicted_organs[0] ? `판단 부위 ${ORGAN_LABEL[details.predicted_organs[0].organ] ?? details.predicted_organs[0].organ}` : null,
    details.remaining_requests != null ? `Pl@ntNet 남은 요청 ${details.remaining_requests}` : null,
  ].filter(Boolean).join(" · ");

  const body = card.querySelector(".result-body");
  body.replaceChildren();

  // 1) 엘프 판별에 쓰는 속을 가장 먼저
  body.append(genusHero(g, job.sample, details.elf_decision));
  if (job.sample) body.append(answerBox(job.sample, details.candidates));

  // 2) 종 후보
  body.append(el("p", "section-label", "종 후보 (신뢰도 순)"));
  const list = document.createElement("ol");
  list.className = "candidates";
  details.candidates.forEach((c, i) => list.append(candidateRow(c, i, job.sample, g?.genus)));
  if (!details.candidates.length) list.append(Object.assign(document.createElement("li"), { textContent: "후보가 없어요." }));
  body.append(list);
  if (details.more_candidates?.length) {
    const more = el("details", "more-cands");
    more.append(el("summary", "", `4~${details.more_candidates.length + 3}위 후보 보기 (화면에는 안 보여주고 DB 매칭에 씀)`));
    const ol = el("ol", "mini-cands");
    ol.start = 4;
    for (const c of details.more_candidates) {
      const item = el("li", "");
      item.append(el("i", "", c.scientific_name), document.createTextNode(` ${pct(c.confidence)} · ${c.genus} · ${c.family}`));
      if (job.sample && sameName(job.sample, c.scientific_name)) item.append(el("span", "mini-badge ok", job.sample.reference ? "기준 종" : "정답"));
      ol.append(item);
    }
    more.append(ol);
    body.append(more);
  }

  const top = details.candidates[0];
  if (top && top.confidence < 0.5) {
    const tip = el("p", "tip",
      "1순위 종 신뢰도가 50% 미만이에요. 60장 테스트에서 이 구간은 종이 자주 틀렸지만 속은 대부분 맞았어요. 잎이나 꽃을 가까이 찍으면 나아져요.");
    body.append(tip);
  }

  // 3) 기술 정보: 입력 → 출력
  body.append(ioPanel(job, [
    ["① 앱 → 우리 서버", [
      ["요청", `POST ${meta.received.path}`],
      ["Content-Type", meta.received.content_type],
      ["본문", job.input.sent],
      ["원본 사진", job.input.original],
    ]],
    ["② 우리 서버 → Pl@ntNet", [
      ["요청", `${meta.upstream.method} ${meta.upstream.url}`],
      ["본문", `${meta.upstream.content_type} · organs=${meta.upstream.form.organs} · images=${meta.upstream.form.images}`],
      ["응답", `${meta.upstream.status} · ${(meta.elapsed_ms / 1000).toFixed(2)}초 · 모델 ${details.plantnet_version ?? "-"}`],
    ]],
  ], ["③ 우리 서버 → 앱 · I-1 응답 (200)", response,
    "species_id·korean_name·character_id·is_collected는 DB에서 채우는 칸이라 null이에요."],
  [
    jsonBlock("Pl@ntNet 원본 응답", result.plantnet_raw),
    jsonBlock("화면용 보조 정보 (details·meta)", { details, meta }),
  ]));
}

function genusHero(g, sample, decision) {
  const box = el("div", "genus-hero");
  box.append(el("p", "genus-label", "엘프 판별 · 속 (genus)"));
  if (!g) {
    box.append(el("p", "genus-name", "알 수 없음"));
    return box;
  }
  const line = el("div", "genus-line");
  const name = el("p", "genus-name");
  name.append(el("i", "", g.genus));
  line.append(name, el("span", "genus-score", pct(g.confidence)));
  box.append(line);
  box.append(el("p", "genus-sub",
    `과 ${g.family ?? "-"} · 후보 3개 중 ${g.candidates_in_genus}개가 이 속 (신뢰도 합)`));
  const bar = el("div", "bar genus-bar");
  bar.setAttribute("aria-hidden", "true");
  const fill = el("span", "");
  fill.style.width = `${Math.max(2, g.confidence * 100)}%`;
  bar.append(fill);
  box.append(bar);
  if (decision) box.append(decisionLine(decision));
  if (sample) {
    const ok = g.genus === sample.genus;
    box.classList.add(ok ? "is-ok" : "is-no");
    const label = sample.reference ? "기준 속" : "정답 속";
    box.append(el("p", `genus-verdict ${ok ? "ok" : "no"}`, ok ? `✓ ${label}이에요 (${sample.genus})` : `✗ ${label}은 ${sample.genus}예요`));
  }
  return box;
}

// 엘프를 속·과 중 어디까지 정할지 (서버 규칙: 1위 속이 2위의 2배 이상 → 속, 아니면 한 과 80% 이상 → 과)
function decisionLine(d) {
  const ratio = d.genus_ratio === null ? "속이 하나뿐" : `1위 속이 2위의 ${d.genus_ratio}배`;
  const share = `${d.family ?? "-"} ${pct(d.family_share)}`;
  const [cls, text] = {
    genus: ["ok", `엘프 판정: 속으로 정해요 (${ratio})`],
    family: ["warn", `엘프 판정: 속이 갈려서 과(${d.family})로 정해요 (${ratio}, 과 비중 ${share})`],
    retake: ["no", `엘프 판정 보류: 속·과 모두 애매해요 (${ratio}, 가장 큰 과 ${share}). 잎이나 꽃을 가까이 한 장 더 찍어 주세요.`],
  }[d.level];
  const p = el("p", `genus-decision ${cls}`, text);
  p.title = `후보 ${d.results_used}개로 계산`;
  return p;
}

function candidateRow(c, i, sample, topGenus) {
  const li = document.createElement("li");
  li.className = "cand";
  const rank = el("span", "rank", String(i + 1));
  const main = el("div", "cand-main");
  const name = el("p", "sci");
  name.append(el("i", "", c.scientific_name), document.createTextNode(" "), el("span", "auth", c.authorship));
  if (sample && sameName(sample, c.scientific_name)) name.append(el("span", "mini-badge ok", sample.reference ? "기준 종" : "정답"));
  const bar = el("div", "bar");
  bar.setAttribute("aria-hidden", "true");
  const fill = el("span", "");
  fill.style.width = `${Math.max(2, c.confidence * 100)}%`;
  bar.append(fill);
  const taxa = el("p", "taxa");
  const genus = el("span", c.genus === topGenus ? "taxa-genus" : "", `속 ${c.genus ?? "-"}`);
  taxa.append(genus, document.createTextNode(` · 과 ${c.family ?? "-"}`));
  main.append(name, el("p", "common", c.common_names.join(", ") || "일반명 없음"), bar, taxa);
  li.append(rank, main, el("span", "score", pct(c.confidence)));
  return li;
}

function answerBox(sample, candidates) {
  const top = candidates[0];
  const box = el("div", "answer");
  const label = sample.reference ? "기준 종" : "정답";
  box.append(el("p", "answer-title", `${label}: ${sample.korean_name} (${sample.scientific_name})`));
  if (sample.reference) box.append(el("p", "hint", `${sample.location} · ${sample.reference}`));
  const checks = el("div", "checks");
  const mark = (label, ok, strong) => el("span", `check ${ok ? "ok" : "no"}${strong ? " strong" : ""}`, `${ok ? "✓" : "✗"} ${label}`);
  checks.append(
    mark("속 (엘프)", Boolean(top && top.genus === sample.genus), true),
    mark("과", Boolean(top && top.family === sample.family)),
    mark("종 1순위", Boolean(top && sameName(sample, top.scientific_name))),
    mark("종 3순위 안", candidates.some((c) => sameName(sample, c.scientific_name))),
  );
  box.append(checks);
  return box;
}

/** 입력 → 출력 기술 정보. steps: [제목, [[키, 값]...]], output: [제목, JSON, 메모], extras: 접힌 JSON 블록 */
function ioPanel(job, steps, output, extras = []) {
  const panel = el("section", "io");
  panel.append(el("p", "section-label", "입력 → 출력 (기술 정보)"));
  for (const [title, rows] of steps) {
    const step = el("div", "io-step");
    step.append(el("p", "io-title", title));
    const dl = el("dl", "io-kv");
    for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
    step.append(dl);
    panel.append(step);
  }
  if (output) {
    const [title, data, note] = output;
    const step = el("div", "io-step");
    step.append(el("p", "io-title", title));
    if (note) step.append(el("p", "hint", note));
    const pre = el("pre", "json", JSON.stringify(data, null, 2));
    pre.tabIndex = 0;
    step.append(pre, copyButton(pre));
    panel.append(step);
  }
  panel.append(...extras);
  return panel;
}

function jsonBlock(title, data, note) {
  const d = el("details", "json-block");
  const s = el("summary", "", title);
  const pre = el("pre", "json", JSON.stringify(data, null, 2));
  pre.tabIndex = 0;
  d.append(s);
  if (note) d.append(el("p", "hint", note));
  d.append(pre, copyButton(pre));
  return d;
}

function copyButton(pre) {
  const copy = el("button", "btn ghost small", "복사");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      flash(copy, "복사했어요");
    } catch {
      flash(copy, "복사 실패");
    }
  });
  return copy;
}

function showError(job, code, message, status, payload) {
  setChip(job.card, "bad", status ? `${status} 에러` : "에러");
  job.card.querySelector(".result-sub").textContent = code;
  const body = job.card.querySelector(".result-body");
  const box = el("div", "error-box");
  box.append(el("p", "code", status ? `${status} ${code}` : code), el("p", "", message));
  body.replaceChildren(box);
  if (job.input) {
    body.append(ioPanel(job, [
      ["① 앱 → 우리 서버", [
        ["요청", `POST ${job.input.path}`],
        ["Content-Type", "image/jpeg"],
        ["본문", job.input.sent],
        ["원본 사진", job.input.original],
      ]],
    ], [`② 우리 서버 → 앱 · 에러 응답 (${status ?? "-"})`, payload ?? { error: { code, message } }]));
  }
}

function setChip(card, tone, text) {
  const chip = card.querySelector(".chip");
  chip.className = `chip ${tone}`;
  chip.textContent = text;
}

function confidenceTone(v) {
  return v >= 0.5 ? "good" : "warn";
}

function syncEmpty() {
  const has = $("results").children.length > 0;
  $("empty").hidden = has;
  $("clear").hidden = !has;
}

async function loadQuota() {
  try {
    const { configured, service_limit: l } = await (await fetch("/api/status")).json();
    $("quota").textContent = configured
      ? `오늘 이 서버에서 ${l.used} / ${l.limit}회 사용`
      : "서버에 Pl@ntNet 키가 설정되지 않았어요.";
  } catch {
    $("quota").textContent = "";
  }
}
loadQuota();

// ---------- 도우미 ----------
const norm = (s) => (s ?? "").toLowerCase().replace(/×/g, "x").replace(/\s+/g, " ").trim();
function sameName(sample, name) {
  return [sample.scientific_name, ...(sample.synonyms ?? [])].map(norm).includes(norm(name));
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 1200);
}
function toast(text) {
  const t = el("div", "toast", text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
