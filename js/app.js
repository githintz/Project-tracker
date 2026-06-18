/* ============================================================
   Orbit — app logic
   ============================================================ */

import {
  uid, normalizeProject, initBackend, localBackend, connectSupabase,
  getSyncConfig, saveSyncConfig,
} from "./store.js";

const COLORS = ["#7c6cff", "#ff6cab", "#3ddc97", "#6cb8ff", "#ffc36c", "#ff8a5c", "#b39bff", "#5ce8e0"];
const STATUS_LABELS = { planning: "Planning", active: "Active", paused: "On hold", done: "Done" };

const CARD_W = 290;
const CARD_GAP = 28;
const TREE_COL = CARD_W + 96;   // horizontal spacing between tree layers
const TREE_ROW = 232;           // vertical spacing within a layer

const LS_THEME_KEY = "orbit.theme.v1";

let backend = localBackend();
let state = { projects: [], updates: [] };
let openProjectId = null;
let editingProjectId = null;
let viewerMode = false;
let theme = { mode: "dark", accent: null };

const $ = (sel) => document.querySelector(sel);
const board = $("#board");
const edgesEl = $("#edges");

/* ---------------- formatting helpers ---------------- */

const fmtFull = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function fmtRelative(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const byId = (id) => state.projects.find((p) => p.id === id);

function projectUpdates(id) {
  return state.updates
    .filter((u) => u.project_id === id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function childrenOf(id) {
  return state.projects.filter((p) => (p.parents ?? []).includes(id));
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove("out");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => { el.hidden = true; }, 350);
  }, 2600);
}

/* ---------------- theme ---------------- */

function loadTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(LS_THEME_KEY));
    if (t && (t.mode === "dark" || t.mode === "light")) theme = { mode: t.mode, accent: t.accent ?? null };
  } catch { /* defaults */ }
}

function applyTheme() {
  document.body.classList.toggle("light", theme.mode === "light");
  const root = document.documentElement;
  if (theme.accent) root.style.setProperty("--accent", theme.accent);
  else root.style.removeProperty("--accent");

  // reflect in the appearance modal controls
  document.querySelectorAll("#theme-seg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === theme.mode));
  document.querySelectorAll("#accent-swatches .swatch").forEach((s) =>
    s.classList.toggle("selected", s.dataset.color === (theme.accent ?? "#7c6cff")));
  const picker = $("#f-accent");
  if (picker) picker.value = theme.accent ?? "#7c6cff";
}

function saveTheme() {
  localStorage.setItem(LS_THEME_KEY, JSON.stringify(theme));
}

/* ---------------- board layout ---------------- */

function gridPositions(count) {
  const usable = Math.max(board.clientWidth - CARD_GAP, CARD_W);
  const cols = Math.max(1, Math.floor(usable / (CARD_W + CARD_GAP)));
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push({
      x: CARD_GAP + (i % cols) * (CARD_W + CARD_GAP),
      y: CARD_GAP + Math.floor(i / cols) * TREE_ROW,
    });
  }
  return positions;
}

function nextFreePosition() {
  const grid = gridPositions(state.projects.length + 8);
  const taken = state.projects.map((p) => ({ x: p.x, y: p.y }));
  for (const g of grid) {
    const clash = taken.some((t) => Math.abs(t.x - g.x) < 60 && Math.abs(t.y - g.y) < 60);
    if (!clash) return g;
  }
  return grid[grid.length - 1];
}

function fitBoardHeight() {
  const maxY = state.projects.reduce((m, p) => Math.max(m, (p.y ?? 0)), 0);
  board.style.minHeight = `${Math.max(maxY + 340, window.innerHeight - 65)}px`;
}

/* depth = longest path from a root (project with no known parents) */
function computeDepths() {
  const depth = new Map();
  const visit = (id, stack) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;            // cycle guard
    stack.add(id);
    const p = byId(id);
    const parents = (p?.parents ?? []).filter(byId);
    const d = parents.length ? Math.max(...parents.map((pid) => visit(pid, stack) + 1)) : 0;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  state.projects.forEach((p) => visit(p.id, new Set()));
  return depth;
}

const hasAnyLinks = () => state.projects.some((p) => (p.parents ?? []).length > 0);

/* Arrange: grid when nothing is linked, left-to-right tree when links exist. */
function autoArrange() {
  if (hasAnyLinks()) {
    const depth = computeDepths();
    const layers = new Map();
    // keep a stable order so children tend to sit near their parents
    [...state.projects]
      .sort((a, b) => (depth.get(a.id) - depth.get(b.id)) || a.created_at.localeCompare(b.created_at))
      .forEach((p) => {
        const d = depth.get(p.id);
        if (!layers.has(d)) layers.set(d, []);
        layers.get(d).push(p);
      });
    for (const [d, group] of layers) {
      group.forEach((p, i) => {
        p.x = CARD_GAP + d * TREE_COL;
        p.y = CARD_GAP + i * TREE_ROW;
      });
    }
  } else {
    const grid = gridPositions(state.projects.length);
    state.projects.forEach((p, i) => { p.x = grid[i].x; p.y = grid[i].y; });
  }

  state.projects.forEach((p) => {
    const card = board.querySelector(`.project-card[data-id="${p.id}"]`);
    if (card) {
      card.style.setProperty("--x", `${p.x}px`);
      card.style.setProperty("--y", `${p.y}px`);
    }
  });
  fitBoardHeight();
  animateEdges();
  backend.savePositions(state.projects.map(({ id, x, y }) => ({ id, x, y }))).catch(syncFail);
}

/* ---------------- edges (connections) ---------------- */

function redrawEdges() {
  if (window.matchMedia("(max-width: 720px)").matches) { edgesEl.innerHTML = ""; return; }
  const cards = new Map();
  board.querySelectorAll(".project-card").forEach((el) => cards.set(el.dataset.id, el));

  let paths = "";
  for (const child of state.projects) {
    for (const pid of child.parents ?? []) {
      const a = cards.get(pid);
      const b = cards.get(child.id);
      if (!a || !b) continue;
      const ax = a.offsetLeft + a.offsetWidth;
      const ay = a.offsetTop + a.offsetHeight / 2;
      const bx = b.offsetLeft;
      const by = b.offsetTop + b.offsetHeight / 2;
      const mx = (ax + bx) / 2;
      const dim = a.classList.contains("filtered-out") || b.classList.contains("filtered-out");
      paths += `<path class="${dim ? "edge-dim" : ""}" marker-end="url(#arrow)" d="M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}" />`;
    }
  }
  edgesEl.innerHTML =
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
       <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--edge)" />
     </marker></defs>${paths}`;
}

function animateEdges(ms = 650) {
  const start = performance.now();
  const loop = (t) => {
    redrawEdges();
    if (t - start < ms) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* ---------------- rendering: board ---------------- */

function render() {
  board.querySelectorAll(".project-card").forEach((el) => el.remove());
  $("#empty-state").hidden = state.projects.length > 0;

  state.projects.forEach((p, i) => {
    const card = document.createElement("article");
    card.className = "project-card";
    card.dataset.id = p.id;
    card.style.setProperty("--x", `${p.x ?? CARD_GAP}px`);
    card.style.setProperty("--y", `${p.y ?? CARD_GAP}px`);
    card.style.setProperty("--card-accent", p.color || COLORS[0]);
    card.style.animationDelay = `${Math.min(i * 60, 400)}ms`;

    const updates = projectUpdates(p.id);
    const last = updates[updates.length - 1];
    const previewItems = updates.slice(-3).reverse();
    const linkCount = (p.parents?.length ?? 0) + childrenOf(p.id).length;

    card.innerHTML = `
      <div class="card-top">
        <span class="status-pill status-${p.status}">${STATUS_LABELS[p.status] ?? p.status}</span>
        ${linkCount ? `<span class="card-link-badge" title="Linked to ${linkCount} project(s)">
          <svg viewBox="0 0 24 24"><path d="M9 12h6M8 8a4 4 0 0 0 0 8h2m4-8h2a4 4 0 0 1 0 8h-2"/></svg>${linkCount}</span>` : ""}
      </div>
      <h3 class="card-title">${escapeHtml(p.name)}</h3>
      <p class="card-desc">${escapeHtml(p.description)}</p>
      ${p.next_step ? `<div class="card-next">
        <svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg><span>${escapeHtml(p.next_step)}</span></div>` : ""}
      <div class="tag-row">${(p.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-foot">
        <span class="updates-chip">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none"/><path d="M12 8v4l2.5 2.5"/></svg>
          ${updates.length} update${updates.length === 1 ? "" : "s"}
        </span>
        <span>${last ? `updated ${fmtRelative(last.created_at)}` : `created ${fmtRelative(p.created_at)}`}</span>
      </div>
      <div class="card-preview">
        ${p.next_step ? `<p class="preview-next"><strong>Next:</strong> ${escapeHtml(p.next_step)}</p>` : ""}
        <h4>Latest updates</h4>
        ${previewItems.length
          ? `<ul>${previewItems.map((u) => `
              <li><time>${fmtFull(u.created_at)}</time>${escapeHtml(u.body)}</li>`).join("")}</ul>`
          : `<p class="preview-empty">No updates yet${viewerMode ? "." : " — click to add the first one."}</p>`}
        <p class="preview-hint">${viewerMode ? "Click to open" : "Click to open · drag to move"}</p>
      </div>`;

    attachCard(card, p);
    board.appendChild(card);
  });

  applySearch();
  fitBoardHeight();
  redrawEdges();
}

/* ---------------- drag / click handling ---------------- */

function attachCard(card, project) {
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const stacked = window.matchMedia("(max-width: 720px)").matches;

    if (viewerMode || stacked) {
      // read-only / mobile: tap to open, never drag
      const upOnce = () => { openDetail(project.id); window.removeEventListener("pointerup", upOnce); };
      window.addEventListener("pointerup", upOnce, { once: true });
      return;
    }

    const startX = e.clientX, startY = e.clientY;
    const origX = project.x ?? 0, origY = project.y ?? 0;
    let moved = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        card.classList.add("dragging");
        card.setPointerCapture(e.pointerId);
      }
      if (moved) {
        project.x = Math.max(0, origX + dx);
        project.y = Math.max(0, origY + dy);
        card.style.setProperty("--x", `${project.x}px`);
        card.style.setProperty("--y", `${project.y}px`);
        redrawEdges();
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        card.classList.remove("dragging");
        fitBoardHeight();
        redrawEdges();
        backend.savePosition(project.id, project.x, project.y).catch(syncFail);
      } else {
        openDetail(project.id);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* ---------------- search ---------------- */

function applySearch() {
  const q = $("#search").value.trim().toLowerCase();
  board.querySelectorAll(".project-card").forEach((card) => {
    const p = byId(card.dataset.id);
    const hay = `${p.name} ${p.description} ${p.next_step} ${(p.tags ?? []).join(" ")}`.toLowerCase();
    card.classList.toggle("filtered-out", q !== "" && !hay.includes(q));
  });
  redrawEdges();
}

/* ---------------- detail overlay ---------------- */

function openDetail(id) {
  openProjectId = id;
  renderDetail();
  $("#detail-overlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  $("#detail-overlay").hidden = true;
  $("#composer").hidden = true;
  $("#add-update-btn").hidden = false;
  $("#nextstep-editor").hidden = true;
  openProjectId = null;
  document.body.style.overflow = "";
}

function renderDetail() {
  const p = byId(openProjectId);
  if (!p) return closeDetail();

  $(".detail-panel").style.setProperty("--card-accent", p.color || COLORS[0]);
  const pill = $("#detail-status");
  pill.className = `status-pill status-${p.status}`;
  pill.textContent = STATUS_LABELS[p.status] ?? p.status;
  $("#detail-created").textContent = `since ${fmtDate(p.created_at)}`;
  $("#detail-title").textContent = p.name;
  $("#detail-desc").textContent = p.description ?? "";
  $("#detail-tags").innerHTML =
    (p.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");

  // next step
  const nsText = $("#detail-nextstep-text");
  if (p.next_step) { nsText.textContent = p.next_step; nsText.classList.remove("empty"); }
  else { nsText.textContent = viewerMode ? "No next step set." : "No next step yet — click Edit to add one."; nsText.classList.add("empty"); }
  $("#nextstep-editor").hidden = true;
  nsText.hidden = false;
  $("#detail-nextstep .nextstep-head").hidden = false;

  // linked projects
  renderLinks(p);

  // updates timeline
  const updates = projectUpdates(p.id);
  $("#update-count").textContent = updates.length;
  const timeline = $("#timeline");
  timeline.innerHTML = updates.length
    ? updates.map((u, i) => `
        <li class="timeline-item" style="animation-delay:${Math.min(i * 40, 300)}ms">
          <time datetime="${u.created_at}">${fmtFull(u.created_at)}</time>
          <div class="update-body">${escapeHtml(u.body)}<button class="update-delete" data-update="${u.id}" title="Delete update">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button></div>
        </li>`).join("")
    : `<li class="timeline-empty">No updates yet.${viewerMode ? "" : " Log your first one below."}</li>`;
}

function renderLinks(p) {
  const parents = (p.parents ?? []).map(byId).filter(Boolean);
  const children = childrenOf(p.id);
  const block = $("#detail-links");
  if (!parents.length && !children.length) { block.hidden = true; return; }
  block.hidden = false;

  const chip = (proj) =>
    `<button class="link-chip" data-goto="${proj.id}" style="--chip-c:${proj.color}">
       <span class="dot"></span>${escapeHtml(proj.name)}</button>`;

  let html = "";
  if (parents.length)
    html += `<div><p class="links-group-label">Builds on the results of</p><div class="link-chips">${parents.map(chip).join("")}</div></div>`;
  if (children.length)
    html += `<div><p class="links-group-label">Leads into</p><div class="link-chips">${children.map(chip).join("")}</div></div>`;
  $("#detail-links-body").innerHTML = html;
}

/* update composer */

function openComposer() {
  $("#add-update-btn").hidden = true;
  const composer = $("#composer");
  composer.hidden = false;
  const ta = $("#composer-text");
  ta.value = "";
  ta.focus();
  composer.scrollIntoView({ behavior: "smooth", block: "end" });
}

function closeComposer() {
  $("#composer").hidden = true;
  $("#add-update-btn").hidden = false;
}

async function saveUpdate() {
  const body = $("#composer-text").value.trim();
  if (!body || !openProjectId) return;
  const update = { id: uid(), project_id: openProjectId, body, created_at: new Date().toISOString() };
  state.updates.push(update);
  closeComposer();
  renderDetail();
  render();
  try { await backend.addUpdate(update); } catch (err) { syncFail(err); }
}

/* next-step inline editor */

function openNextStepEditor() {
  const p = byId(openProjectId);
  if (!p) return;
  $("#detail-nextstep-text").hidden = true;
  $("#detail-nextstep .nextstep-head").hidden = true;
  const editor = $("#nextstep-editor");
  editor.hidden = false;
  const input = $("#nextstep-input");
  input.value = p.next_step ?? "";
  input.focus();
}

async function saveNextStep() {
  const p = byId(openProjectId);
  if (!p) return;
  p.next_step = $("#nextstep-input").value.trim();
  renderDetail();
  render();
  try { await backend.upsertProject(p); } catch (err) { syncFail(err); }
}

/* ---------------- project create / edit ---------------- */

function buildSwatches(container, selected, attr = "color") {
  container.innerHTML = COLORS.map((c) => `
    <button type="button" class="swatch ${c === selected ? "selected" : ""}"
            style="--c:${c}" data-${attr}="${c}" aria-label="${c}"></button>`).join("");
}

function populateParentOptions(project) {
  const sel = $("#f-parents");
  const chosen = new Set(project?.parents ?? []);
  const others = state.projects.filter((p) => p.id !== project?.id);
  sel.innerHTML = others.length
    ? others.map((p) => `<option value="${p.id}" ${chosen.has(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")
    : "";
  sel.disabled = others.length === 0;
}

function openProjectModal(project = null) {
  editingProjectId = project?.id ?? null;
  $("#project-modal-title").textContent = project ? "Edit project" : "New project";
  $("#project-save-btn").textContent = project ? "Save changes" : "Create project";
  $("#f-name").value = project?.name ?? "";
  $("#f-desc").value = project?.description ?? "";
  $("#f-next").value = project?.next_step ?? "";
  $("#f-status").value = project?.status ?? "active";
  $("#f-tags").value = (project?.tags ?? []).join(", ");
  populateParentOptions(project);
  buildSwatches($("#f-colors"), project?.color ?? COLORS[state.projects.length % COLORS.length]);
  $("#project-modal").hidden = false;
  $("#f-name").focus();
}

async function submitProject(e) {
  e.preventDefault();
  const name = $("#f-name").value.trim();
  if (!name) return;

  const color = $("#f-colors .swatch.selected")?.dataset.color ?? COLORS[0];
  const tags = $("#f-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const parents = [...$("#f-parents").selectedOptions].map((o) => o.value);
  const existing = byId(editingProjectId);

  const project = existing
    ? { ...existing, name, description: $("#f-desc").value.trim(), next_step: $("#f-next").value.trim(),
        status: $("#f-status").value, color, tags, parents }
    : {
        id: uid(), name,
        description: $("#f-desc").value.trim(),
        next_step: $("#f-next").value.trim(),
        status: $("#f-status").value,
        color, tags, parents,
        ...nextFreePosition(),
        created_at: new Date().toISOString(),
      };

  if (existing) Object.assign(existing, project);
  else state.projects.push(project);

  $("#project-modal").hidden = true;
  render();
  if (openProjectId) renderDetail();
  try { await backend.upsertProject(project); } catch (err) { syncFail(err); }
}

/* ---------------- confirm dialog ---------------- */

function confirmDanger(title, sub, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    $("#confirm-text").textContent = title;
    $("#confirm-sub").textContent = sub;
    $("#confirm-yes").textContent = confirmLabel;
    const modal = $("#confirm-modal");
    modal.hidden = false;
    const done = (ok) => {
      modal.hidden = true;
      $("#confirm-yes").onclick = $("#confirm-no").onclick = null;
      resolve(ok);
    };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
  });
}

async function deleteCurrentProject() {
  const p = byId(openProjectId);
  if (!p) return;
  const ok = await confirmDanger(
    `Delete “${p.name}”?`,
    "The project and all of its updates will be removed. Links from other projects to it are also cleared. This cannot be undone."
  );
  if (!ok) return;

  // clear references to this project from others' parent lists
  const affected = state.projects.filter((x) => (x.parents ?? []).includes(p.id));
  affected.forEach((x) => { x.parents = x.parents.filter((id) => id !== p.id); });

  state.projects = state.projects.filter((x) => x.id !== p.id);
  state.updates = state.updates.filter((u) => u.project_id !== p.id);
  closeDetail();
  render();
  try {
    await Promise.all(affected.map((x) => backend.upsertProject(x)));
    await backend.deleteProject(p.id);
  } catch (err) { syncFail(err); }
}

/* ---------------- appearance ---------------- */

function openAppearance() {
  buildSwatches($("#accent-swatches"), theme.accent ?? "#7c6cff");
  applyTheme();
  $("#appearance-modal").hidden = false;
}

function setMode(mode) { theme.mode = mode; applyTheme(); saveTheme(); }
function setAccent(hex) { theme.accent = hex; applyTheme(); saveTheme(); }

/* ---------------- sharing ---------------- */

function buildShareLink() {
  const cfg = getSyncConfig();
  if (!cfg?.url || !cfg?.key) return null;
  const payload = btoa(JSON.stringify({ u: cfg.url, k: cfg.key }));
  return `${location.origin}${location.pathname}?view=${payload}`;
}

function parseViewParam() {
  const raw = new URLSearchParams(location.search).get("view");
  if (!raw) return null;
  try {
    const { u, k } = JSON.parse(atob(raw));
    if (u && k) return { url: u, key: k };
  } catch { /* malformed */ }
  return null;
}

function openShareModal() {
  const link = buildShareLink();
  const ready = $("#share-ready");
  const needs = $("#share-needs-sync");
  const connectBtn = $("#share-connect");
  if (link) {
    $("#share-link").value = link;
    ready.hidden = false;
    needs.hidden = true;
    connectBtn.hidden = true;
  } else {
    ready.hidden = true;
    needs.hidden = false;
    connectBtn.hidden = false;
  }
  $("#share-modal").hidden = false;
}

/* ---------------- sync (Supabase) ---------------- */

function syncFail(err) {
  console.error(err);
  toast(`Sync error: ${err.message ?? err}`);
}

function refreshSyncLabel() {
  $("#sync-label").textContent = backend.kind === "supabase" ? "Synced" : "Local";
}

let reloadTimer = null;
function scheduleRealtimeReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      const data = await backend.loadAll();
      ingest(data);
      render();
      if (openProjectId) {
        if (byId(openProjectId)) renderDetail();
        else closeDetail();
      }
    } catch (err) { syncFail(err); }
  }, 350);
}

function subscribeRealtime() {
  if (backend.kind !== "supabase") return;
  backend.subscribe(scheduleRealtimeReload);
}

function ingest(data) {
  state = {
    projects: (data.projects ?? []).map(normalizeProject),
    updates: data.updates ?? [],
  };
}

function openSyncModal() {
  const cfg = getSyncConfig();
  $("#f-sb-url").value = cfg?.url ?? "";
  $("#f-sb-key").value = cfg?.key ?? "";
  $("#sync-error").hidden = true;
  $("#sync-disconnect").hidden = backend.kind !== "supabase";
  $("#sync-modal").hidden = false;
}

async function submitSync(e) {
  e.preventDefault();
  const url = $("#f-sb-url").value.trim();
  const key = $("#f-sb-key").value.trim();
  const errEl = $("#sync-error");
  errEl.hidden = true;
  if (!url || !key) {
    errEl.textContent = "Both the project URL and the anon key are required.";
    errEl.hidden = false;
    return;
  }

  const btn = $("#sync-connect-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const sb = await connectSupabase(url, key);
    const remote = await sb.loadAll();

    if (remote.projects.length === 0 && state.projects.length > 0) {
      const push = await confirmDanger(
        "Upload local projects?",
        `Your Supabase tables are empty. Copy your ${state.projects.length} local project(s) and their updates to the cloud?`,
        "Upload"
      );
      if (push) {
        for (const p of state.projects) await sb.upsertProject(p);
        for (const u of state.updates) await sb.addUpdate(u);
      }
    }

    if (backend.kind === "supabase") backend.unsubscribe();
    backend = sb;
    saveSyncConfig({ url, key });
    ingest(await backend.loadAll());
    subscribeRealtime();
    $("#sync-modal").hidden = true;
    refreshSyncLabel();
    render();
    toast("Connected — syncing with Supabase");
  } catch (err) {
    errEl.textContent = `Could not connect: ${err.message}`;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

async function disconnectSync() {
  if (backend.kind === "supabase") backend.unsubscribe();
  saveSyncConfig(null);
  backend = localBackend();
  ingest(await backend.loadAll());
  $("#sync-modal").hidden = true;
  refreshSyncLabel();
  render();
  toast("Back to local storage");
}

/* ---------------- wiring ---------------- */

function wire() {
  $("#new-project-btn").addEventListener("click", () => openProjectModal());
  $("#empty-state [data-action='new-project']").addEventListener("click", () => openProjectModal());
  $("#project-form").addEventListener("submit", submitProject);
  $("#arrange-btn").addEventListener("click", autoArrange);
  $("#search").addEventListener("input", applySearch);

  $("#f-colors").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    $("#f-colors .selected")?.classList.remove("selected");
    sw.classList.add("selected");
  });

  // detail overlay
  $("#add-update-btn").addEventListener("click", openComposer);
  $("#composer-cancel").addEventListener("click", closeComposer);
  $("#composer-save").addEventListener("click", saveUpdate);
  $("#composer-text").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveUpdate();
  });

  $("#edit-nextstep-btn").addEventListener("click", openNextStepEditor);
  $("#nextstep-cancel").addEventListener("click", renderDetail);
  $("#nextstep-save").addEventListener("click", saveNextStep);

  $("#edit-project-btn").addEventListener("click", () => {
    const p = byId(openProjectId);
    if (p) openProjectModal(p);
  });
  $("#delete-project-btn").addEventListener("click", deleteCurrentProject);

  // jump between linked projects
  $("#detail-links-body").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-goto]");
    if (chip) openDetail(chip.dataset.goto);
  });

  $("#timeline").addEventListener("click", async (e) => {
    const btn = e.target.closest(".update-delete");
    if (!btn) return;
    const id = btn.dataset.update;
    state.updates = state.updates.filter((u) => u.id !== id);
    renderDetail();
    render();
    try { await backend.deleteUpdate(id); } catch (err) { syncFail(err); }
  });

  // appearance
  $("#theme-btn").addEventListener("click", openAppearance);
  $("#theme-seg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (b) setMode(b.dataset.mode);
  });
  $("#accent-swatches").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (sw) setAccent(sw.dataset.color);
  });
  $("#f-accent").addEventListener("input", (e) => setAccent(e.target.value));
  $("#accent-reset").addEventListener("click", () => { theme.accent = null; applyTheme(); saveTheme(); });

  // sharing
  $("#share-btn").addEventListener("click", openShareModal);
  $("#share-copy").addEventListener("click", async () => {
    const link = $("#share-link").value;
    try { await navigator.clipboard.writeText(link); toast("Share link copied"); }
    catch { $("#share-link").select(); toast("Press ⌘/Ctrl+C to copy"); }
  });
  $("#share-connect").addEventListener("click", () => { $("#share-modal").hidden = true; openSyncModal(); });

  // sync
  $("#sync-btn").addEventListener("click", openSyncModal);
  $("#sync-form").addEventListener("submit", submitSync);
  $("#sync-disconnect").addEventListener("click", disconnectSync);

  // generic close buttons / backdrops
  document.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (!close) return;
    const which = close.dataset.close;
    if (which === "detail") closeDetail();
    else $(`#${which}`).hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#confirm-modal").hidden) $("#confirm-no").click();
    else if (!$("#project-modal").hidden) $("#project-modal").hidden = true;
    else if (!$("#appearance-modal").hidden) $("#appearance-modal").hidden = true;
    else if (!$("#share-modal").hidden) $("#share-modal").hidden = true;
    else if (!$("#sync-modal").hidden) $("#sync-modal").hidden = true;
    else if (!$("#detail-overlay").hidden) closeDetail();
  });

  window.addEventListener("resize", () => { fitBoardHeight(); redrawEdges(); });
}

/* ---------------- boot ---------------- */

async function boot() {
  loadTheme();
  applyTheme();
  wire();

  const view = parseViewParam();
  if (view) {
    // read-only shared view
    viewerMode = true;
    document.body.classList.add("viewer");
    $("#viewer-banner").hidden = false;
    try {
      backend = await connectSupabase(view.url, view.key, true);
      ingest(await backend.loadAll());
      subscribeRealtime();
    } catch (err) {
      toast(`Couldn't open shared board: ${err.message}`);
    }
    render();
    return;
  }

  const { backend: be, syncError } = await initBackend();
  backend = be;
  if (syncError) toast(`Supabase unreachable — using local data (${syncError})`);
  refreshSyncLabel();
  try {
    ingest(await backend.loadAll());
  } catch (err) {
    syncFail(err);
    backend = localBackend();
    ingest(await backend.loadAll());
    refreshSyncLabel();
  }
  subscribeRealtime();
  render();
}

boot();
