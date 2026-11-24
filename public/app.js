// 사진을 앱 규칙(긴 변 1280px, JPEG 0.7)으로 줄여 /api/identify에 보낸다.
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.7;
const ORGAN_LABEL = { auto: "자동", leaf: "잎", flower: "꽃", fruit: "열매", bark: "수피" };

const $ = (id) => document.getElementById(id);
let photo = null; // { blob, previewUrl }
let lastResult = null;
let activeTab = "draft";

for (const input of [$("camera"), $("gallery")]) {
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) await selectPhoto(file);
  });
}
$("submit").addEventListener("click", identify);
$("copy").addEventListener("click", copyJson);
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}
loadQuota();

async function selectPhoto(file) {
  hideError();
  try {
    const blob = await shrink(file);
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    photo = { blob, previewUrl: URL.createObjectURL(blob) };
    $("preview-img").src = photo.previewUrl;
    $("preview-info").textContent = `${kb(file.size)} → 전송 ${kb(blob.size)}`;
    $("preview").hidden = false;
    $("submit").disabled = false;
  } catch {
    showError("INVALID_PHOTO", "이 사진을 읽지 못했어요. JPEG나 PNG 사진으로 다시 시도해 주세요.");
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
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", JPEG_QUALITY),
  );
}

async function identify() {
  if (!photo) return;
  const organ = document.querySelector('input[name="organ"]:checked').value;
  hideError();
  setBusy(true);
  try {
    const res = await fetch(`/api/identify?organ=${organ}`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: photo.blob,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      $("result").hidden = true;
      showError(body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? "요청에 실패했어요.", res.status);
      return;
    }
    lastResult = body;
    renderResult(body);
  } catch {
    showError("NETWORK", "서버에 연결하지 못했어요. 네트워크를 확인해 주세요.");
  } finally {
    setBusy(false);
    loadQuota();
  }
}

function renderResult({ response, details, meta }) {
  const organs = details.predicted_organs.map((o) => `${ORGAN_LABEL[o.organ] ?? o.organ} ${pct(o.score)}`).join(", ");
  $("meta").replaceChildren(
    ...metaRow("요청 부위", ORGAN_LABEL[meta.organ] ?? meta.organ),
    ...metaRow("Pl@ntNet 판단 부위", organs || "-"),
    ...metaRow("응답 시간", `${(meta.elapsed_ms / 1000).toFixed(1)}초`),
    ...metaRow("Pl@ntNet 남은 요청", details.remaining_requests ?? "-"),
  );

  const list = $("candidates");
  list.replaceChildren();
  if (details.candidates.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "후보가 없어요.";
    list.append(li);
  }
  details.candidates.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "candidate";
    li.innerHTML = `
      <div class="rank">${i + 1}</div>
      <div class="body">
        <p class="sci"><i></i> <span class="auth"></span></p>
        <p class="common"></p>
        <div class="bar" aria-hidden="true"><span></span></div>
        <p class="taxa"></p>
      </div>
      <div class="score"></div>`;
    li.querySelector("i").textContent = c.scientific_name;
    li.querySelector(".auth").textContent = c.authorship;
    li.querySelector(".common").textContent = c.common_names.join(", ") || "일반명 없음";
    li.querySelector(".bar span").style.width = `${Math.max(2, c.confidence * 100)}%`;
    li.querySelector(".taxa").textContent = `속 ${c.genus ?? "-"} · 과 ${c.family ?? "-"}`;
    li.querySelector(".score").textContent = pct(c.confidence);
    list.append(li);
  });

  $("result").hidden = false;
  showTab(activeTab);
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const note of document.querySelectorAll("[data-note]")) note.hidden = note.dataset.note !== name;
  if (lastResult) $("json").textContent = JSON.stringify(currentJson(), null, 2);
}

function currentJson() {
  return activeTab === "draft" ? lastResult.response : lastResult.plantnet_raw;
}

async function copyJson() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentJson(), null, 2));
    flash($("copy"), "복사했어요");
  } catch {
    flash($("copy"), "복사 실패");
  }
}

async function loadQuota() {
  try {
    const res = await fetch("/api/status");
    const { configured, service_limit: l } = await res.json();
    $("quota").textContent = configured
      ? `오늘 이 서버에서 ${l.used} / ${l.limit}회 사용`
      : "서버에 Pl@ntNet 키가 설정되지 않았어요.";
  } catch {
    $("quota").textContent = "";
  }
}

function setBusy(busy) {
  $("submit").disabled = busy || !photo;
  $("submit").textContent = busy ? "식별하는 중…" : "식별하기";
  $("submit").setAttribute("aria-busy", String(busy));
}

function showError(code, message, status) {
  const box = $("error");
  box.replaceChildren();
  const title = document.createElement("p");
  title.className = "code";
  title.textContent = status ? `${status} ${code}` : code;
  const text = document.createElement("p");
  text.textContent = message;
  box.append(title, text);
  box.hidden = false;
}

function hideError() {
  $("error").hidden = true;
}

function metaRow(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  return [dt, dd];
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 1200);
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
