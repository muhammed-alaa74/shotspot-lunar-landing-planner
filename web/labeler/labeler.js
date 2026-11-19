// SHOTSPOT crater labeler. Craters are circles in map coordinates (polar stereographic meters),
// so labels stay valid for every lighting and line up with the LOLA DEM.
const $ = (id) => document.getElementById(id);
const CELL = 500;            // work cells of 500 x 500 m
const MIN_D = 10;            // craters smaller than 10 m are not used for training
const KEY = "shotspot-labels-v1";

let AREAS, areaId, layer = "B", imgs = {};          // imgs[area][letter] = ImageBitmap
let store = { labels: [], doneCells: {} };          // doneCells[area] = ["c,r", ...]
let view = { s: 0.25, ox: 0, oy: 0 };               // screen = (px - ox) * s
let sel = null, drag = null, hideLabels = false, mouse = null, history = [];

const cv = $("cv"), g = cv.getContext("2d");

// ------------------------------------------------------------ storage (browser) + files
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode: export still works */ } }
function load() { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s?.labels) store = s; } catch { /* ignore */ } }
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function exportLabels() {
  const who = $("who").value.trim() || "anonymous";
  const blob = new Blob([JSON.stringify({ format: "shotspot-craters-v1", exported_utc: new Date().toISOString(),
    annotator: who, source: AREAS.source, res_m: AREAS.res_m, ...store }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `craters_${who}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`; a.click();
}
async function importFiles(files) {
  let added = 0;
  for (const f of files) {
    const d = JSON.parse(await f.text());
    const ids = new Set(store.labels.map((l) => l.id));
    for (const l of d.labels || []) if (!ids.has(l.id)) { store.labels.push(l); added++; }
    for (const [a, cells] of Object.entries(d.doneCells || {})) store.doneCells[a] = [...new Set([...(store.doneCells[a] || []), ...cells])];
  }
  save(); draw(); stats(); alert(`Imported ${added} new labels.`);
}

// ------------------------------------------------------------ geometry
const A = () => AREAS.areas[areaId];
const pxToMap = (px, py) => ({ x: A().left + px, y: A().top - py });
const mapToPx = (x, y) => ({ px: x - A().left, py: A().top - y });
const screenToPx = (sx, sy) => ({ px: sx / view.s + view.ox, py: sy / view.s + view.oy });
const cellOf = (px, py) => `${Math.floor(px / CELL)},${Math.floor(py / CELL)}`;
const isDone = (key) => (store.doneCells[areaId] || []).includes(key);
const areaLabels = () => store.labels.filter((l) => l.area === areaId);

function fit() {
  const r = cv.getBoundingClientRect(), size = A().size_m;
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  view.s = Math.min(cv.width, cv.height) / size; view.ox = -(cv.width / view.s - size) / 2; view.oy = -(cv.height / view.s - size) / 2;
}

// ------------------------------------------------------------ drawing
function draw() {
  const W = cv.width, H = cv.height, size = A().size_m, s = view.s;
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  g.setTransform(s, 0, 0, s, -view.ox * s, -view.oy * s);
  g.imageSmoothingEnabled = s < 2;
  const im = imgs[areaId]?.[layer];
  if (im) g.drawImage(im, 0, 0); else { g.fillStyle = "#222"; g.fillRect(0, 0, size, size); }
  // cells
  g.lineWidth = 1 / s;
  for (let cx = 0; cx < size; cx += CELL) for (let cy = 0; cy < size; cy += CELL) {
    const key = `${cx / CELL},${cy / CELL}`;
    g.strokeStyle = isDone(key) ? "rgba(47,208,160,.9)" : "rgba(125,211,252,.35)";
    g.strokeRect(cx, cy, CELL, CELL);
    if (isDone(key)) { g.fillStyle = "rgba(47,208,160,.9)"; g.font = `${14 / s}px system-ui`; g.fillText("✓ done", cx + 6 / s, cy + 18 / s); }
  }
  if (!hideLabels) for (const l of areaLabels()) {
    const p = mapToPx(l.x, l.y), small = 2 * l.r < MIN_D;
    g.beginPath(); g.arc(p.px, p.py, l.r, 0, 2 * Math.PI);
    g.lineWidth = (l === sel ? 3 : 1.6) / s;
    g.strokeStyle = l === sel ? "#ffffff" : small ? "#8b98b0" : l.unsure ? "#ffc94a" : "#2fd0a0";
    if (l.unsure) g.setLineDash([4 / s, 3 / s]); g.stroke(); g.setLineDash([]);
  }
  if (drag?.mode === "draw") {
    g.beginPath(); g.arc(drag.px, drag.py, drag.r, 0, 2 * Math.PI); g.strokeStyle = "#7dd3fc"; g.lineWidth = 2 / s; g.stroke();
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#7dd3fc"; g.font = `${13 * devicePixelRatio}px system-ui`;
    g.fillText(`D = ${(2 * drag.r).toFixed(1)} m${2 * drag.r < MIN_D ? " (too small, < 10 m)" : ""}`, drag.sx + 14, drag.sy - 10);
  }
}

function stats() {
  const all = store.labels.filter((l) => 2 * l.r >= MIN_D), n = all.length;
  $("total").textContent = n.toLocaleString(); $("bar").style.width = `${Math.min(100, (n / 1000) * 100)}%`;
  $("perArea").innerHTML = Object.keys(AREAS.areas).map((a) => {
    const k = all.filter((l) => l.area === a).length, done = (store.doneCells[a] || []).length, cells = (AREAS.areas[a].size_m / CELL) ** 2;
    return `<tr><td>${a} <small>(${AREAS.areas[a].role})</small></td><td>${k} · ${done}/${cells} cells</td></tr>`;
  }).join("");
  const bins = [[10, 20], [20, 50], [50, 100], [100, 1e9]];
  $("bins").innerHTML = bins.map(([a, b]) => `<tr><td>D ${a}${b < 1e9 ? "-" + b : "+"} m</td><td>${all.filter((l) => 2 * l.r >= a && 2 * l.r < b).length}</td></tr>`).join("");
  const sh = store.labels.length - n; $("goal").textContent = `goal 1,000-1,500${sh ? ` · ${sh} under 10 m not counted` : ""}`;
}

function cellInfo() {
  if (!mouse) return;
  const key = cellOf(mouse.px, mouse.py), [c, r] = key.split(",").map(Number);
  if (c < 0 || r < 0 || c * CELL >= A().size_m || r * CELL >= A().size_m) { $("cellInfo").textContent = "Outside the image."; return; }
  const k = areaLabels().filter((l) => { const p = mapToPx(l.x, l.y); return cellOf(p.px, p.py) === key; }).length;
  $("cellInfo").innerHTML = `Cell <b>${key}</b> · ${k} craters · ${isDone(key) ? "<b style='color:#2fd0a0'>done</b>" : "not done"}`;
}
function selInfo() {
  $("selInfo").innerHTML = sel ? `D = <b>${(2 * sel.r).toFixed(1)} m</b>${sel.unsure ? " · unsure" : ""}<br><small>by ${sel.by || "?"}</small>` : "Click a circle to select it.";
}

// ------------------------------------------------------------ interaction
function hit(px, py) {
  let best = null, bd = Infinity;
  for (const l of areaLabels()) { const p = mapToPx(l.x, l.y), d = Math.hypot(px - p.px, py - p.py);
    if (Math.abs(d - l.r) < 6 / view.s + 2 || d < l.r * 0.35) if (d < bd) { bd = d; best = l; } }
  return best;
}
function evPx(e) { const r = cv.getBoundingClientRect(), sx = (e.clientX - r.left) * devicePixelRatio, sy = (e.clientY - r.top) * devicePixelRatio; return { sx, sy, ...screenToPx(sx, sy) }; }
let space = false;
cv.addEventListener("contextmenu", (e) => e.preventDefault());
cv.addEventListener("pointerdown", (e) => {
  const p = evPx(e); cv.setPointerCapture(e.pointerId);
  if (e.button === 2 || e.button === 1 || space) { drag = { mode: "pan", sx: p.sx, sy: p.sy, ox: view.ox, oy: view.oy }; return; }
  const h = e.altKey ? null : hit(p.px, p.py);   // Alt + drag: draw even on top of another circle
  if (h) { sel = h; selInfo(); draw(); return; }
  drag = { mode: "draw", px: p.px, py: p.py, r: 0, sx: p.sx, sy: p.sy };
});
cv.addEventListener("pointermove", (e) => {
  const p = evPx(e); mouse = p; cellInfo();
  if (!drag) return;
  if (drag.mode === "pan") { view.ox = drag.ox - (p.sx - drag.sx) / view.s; view.oy = drag.oy - (p.sy - drag.sy) / view.s; }
  else { drag.r = Math.hypot(p.px - drag.px, p.py - drag.py); drag.sx = p.sx; drag.sy = p.sy; }
  draw();
});
cv.addEventListener("pointerup", () => {
  if (drag?.mode === "draw" && drag.r * 2 >= 4) {
    const m = pxToMap(drag.px, drag.py);
    const l = { id: uid(), area: areaId, x: +m.x.toFixed(2), y: +m.y.toFixed(2), r: +drag.r.toFixed(2), unsure: false,
      by: $("who").value.trim() || "anonymous", layer, t: new Date().toISOString() };
    store.labels.push(l); history.push({ op: "add", l }); sel = l; save(); stats(); selInfo(); cellInfo();
  }
  drag = null; draw();
});
cv.addEventListener("wheel", (e) => {
  e.preventDefault(); const p = evPx(e), f = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.min(16, Math.max(0.05, view.s * f)); view.ox = p.px - p.sx / ns; view.oy = p.py - p.sy / ns; view.s = ns; draw();
}, { passive: false });

function del() { if (!sel) return; store.labels = store.labels.filter((l) => l !== sel); history.push({ op: "del", l: sel }); sel = null; save(); stats(); selInfo(); cellInfo(); draw(); }
function toggleUnsure() { if (!sel) return; sel.unsure = !sel.unsure; save(); selInfo(); draw(); }
function toggleDone() {
  if (!mouse) return; const key = cellOf(mouse.px, mouse.py), list = store.doneCells[areaId] ||= [];
  const i = list.indexOf(key); i >= 0 ? list.splice(i, 1) : list.push(key); save(); stats(); cellInfo(); draw();
}
function undo() {
  const h = history.pop(); if (!h) return;
  if (h.op === "add") store.labels = store.labels.filter((l) => l !== h.l); else store.labels.push(h.l);
  sel = null; save(); stats(); selInfo(); draw();
}
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { space = true; e.preventDefault(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { undo(); e.preventDefault(); return; }
  const letters = Object.keys(A().mosaics);
  if (/^[1-9]$/.test(e.key) && letters[+e.key - 1]) setLayer(letters[+e.key - 1]);
  if (e.key === "Delete" || e.key === "Backspace") del();
  if (e.key === "u" || e.key === "U") toggleUnsure();
  if (e.key === "d" || e.key === "D") toggleDone();
  if (e.key === "h" || e.key === "H") { hideLabels = !hideLabels; draw(); }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") space = false; });
window.addEventListener("resize", () => { fit(); draw(); });

// ------------------------------------------------------------ areas and lighting layers
function renderLayers() {
  $("layers").innerHTML = Object.entries(A().mosaics).map(([v, m], i) =>
    `<button data-v="${v}" class="${v === layer ? "on" : ""}" title="sub-solar longitude ${m.sub_solar_lon}°, lit ${Math.round(m.lit_fraction * 100)}%">${i + 1} · ${v}</button>`).join("");
  $("layers").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.v)));
}
async function setLayer(v) {
  layer = v; renderLayers();
  imgs[areaId] ||= {};
  if (!imgs[areaId][v]) { const r = await fetch(A().mosaics[v].file); imgs[areaId][v] = await createImageBitmap(await r.blob()); }
  draw();
}
async function setArea(id) {
  areaId = id; sel = null; selInfo();
  if (!A().mosaics[layer]) layer = Object.keys(A().mosaics)[0];
  fit(); renderLayers(); await setLayer(layer); stats();
}

async function init() {
  AREAS = await (await fetch("areas.json")).json();
  load();
  try { $("who").value = localStorage.getItem(KEY + "-who") || ""; } catch { /* ignore */ }
  $("who").addEventListener("change", () => { try { localStorage.setItem(KEY + "-who", $("who").value); } catch { /* ignore */ } });
  $("area").innerHTML = Object.entries(AREAS.areas).map(([k, a]) => `<option value="${k}">${k} (${a.role})</option>`).join("");
  $("area").value = "train1";
  $("area").addEventListener("change", (e) => setArea(e.target.value));
  $("exportBtn").addEventListener("click", exportLabels);
  $("importFile").addEventListener("change", (e) => importFiles(e.target.files));
  $("doneBtn").addEventListener("click", toggleDone);
  $("delBtn").addEventListener("click", del);
  $("unsureBtn").addEventListener("click", toggleUnsure);
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  await setArea("train1");
}
init().catch((e) => { document.body.innerHTML = `<p style="padding:20px">Failed to start: ${e.message}. Run pipeline/nac_crops.py first.</p>`; });
