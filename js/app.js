/* ============================================================
   Orbit — app logic
   ============================================================ */

import {
  uid, normalizeProject, normalizeUpdate, normalizeIdea,
  initBackend, localBackend, connectSupabase,
  getSyncConfig, saveSyncConfig,
} from "./store.js";

const COLORS = ["#7c6cff", "#ff6cab", "#3ddc97", "#6cb8ff", "#ffc36c", "#ff8a5c", "#b39bff", "#5ce8e0"];
const STATUS_LABELS = { planning: "Planning", active: "Active", paused: "On hold", done: "Done" };

const CARD_W = 290;
const CARD_GAP = 28;
const TREE_COL = CARD_W + 96;
const TREE_ROW = 232;

const LS_THEME_KEY = "orbit.theme.v1";

let backend = localBackend();
let state = { projects: [], updates: [], ideas: [] };
let openProjectId = null;
let editingProjectId = null;
let editingIdeaId = null;
let viewerMode = false;
let theme = { mode: "dark", accent: null };

const $ = (sel) => document.querySelector(sel);
const board = $("#board");
const edgesEl = $("#edges");

/* ---------------- URL-safe base64 (for share links) ----------------
   Standard base64 contains "+" and "/"; in a URL query string "+" decodes
   to a space, which silently corrupts the payload. base64url avoids that. */
const b64urlEncode = (str) =>
  btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s) => {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad)));
};

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

const isGoalEntry = (u) => u.kind === "goal";
const makeGoal = (projectId, text) =>
  ({ id: uid(), project_id: projectId, body: text, created_at: new Date().toISOString(), kind: "goal", resources: [] });

function childrenOf(id) {
  return state.projects.filter((p) => (p.parents ?? []).includes(id));
}

/* normalise a URL so a bare "example.com" still becomes a working link */
function normUrl(url) {
  const u = url.trim();
  if (!u) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
}
function hostLabel(url) {
  try { return new URL(normUrl(url)).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function resourceChips(resources) {
  if (!resources?.length) return "";
  return `<div class="res-chips">${resources.map((r) => {
    const href = normUrl(r.url);
    const label = r.title?.trim() || hostLabel(r.url);
    return `<a class="res-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(href)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>
      ${escapeHtml(label)}</a>`;
  }).join("")}</div>`;
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

/* ---------------- resource editor (reusable) ---------------- */

class ResourceEditor {
  constructor(root) {
    this.root = root;
    this.items = [];
    this.listEl = root.querySelector(".res-list");
    this.urlEl = root.querySelector(".res-url");
    this.titleEl = root.querySelector(".res-title");
    root.querySelector(".res-add-btn").addEventListener("click", () => this.add());
    [this.urlEl, this.titleEl].forEach((el) =>
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(); } }));
    this.listEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-remove]");
      if (b) { this.items.splice(+b.dataset.remove, 1); this.render(); }
    });
  }
  set(items) { this.items = (items ?? []).map((r) => ({ url: r.url, title: r.title ?? "" })); this.render(); }
  get() { return this.items.map((r) => ({ url: normUrl(r.url), title: r.title.trim() })); }
  add() {
    const url = this.urlEl.value.trim();
    if (!url) { this.urlEl.focus(); return; }
    this.items.push({ url, title: this.titleEl.value.trim() });
    this.urlEl.value = ""; this.titleEl.value = "";
    this.render();
    this.urlEl.focus();
  }
  render() {
    this.listEl.innerHTML = this.items.map((r, i) => `
      <div class="res-row">
        <svg class="res-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>
        <span class="res-row-label">${escapeHtml(r.title || hostLabel(r.url))}</span>
        <button type="button" class="res-remove" data-remove="${i}" title="Remove" aria-label="Remove">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>`).join("");
  }
}

let projectResEditor, composerResEditor;

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
  document.querySelectorAll("#theme-seg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === theme.mode));
  document.querySelectorAll("#accent-swatches .swatch").forEach((s) =>
    s.classList.toggle("selected", s.dataset.color === (theme.accent ?? "#7c6cff")));
  const picker = $("#f-accent");
  if (picker) picker.value = theme.accent ?? "#7c6cff";
}

function saveTheme() { localStorage.setItem(LS_THEME_KEY, JSON.stringify(theme)); }

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

function computeDepths() {
  const depth = new Map();
  const visit = (id, stack) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
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

function autoArrange() {
  if (hasAnyLinks()) {
    const depth = computeDepths();
    const layers = new Map();
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

/* ---------------- edges ---------------- */

function redrawEdges() {
  if (window.matchMedia("(max-width: 720px)").matches) { edgesEl.innerHTML = ""; return; }
  const cards = new Map();
  board.querySelectorAll(".project-card").forEach((el) => cards.set(el.dataset.id, el));
  let paths = "";
  for (const child of state.projects) {
    for (const pid of child.parents ?? []) {
      const a = cards.get(pid), b = cards.get(child.id);
      if (!a || !b) continue;
      const ax = a.offsetLeft + a.offsetWidth, ay = a.offsetTop + a.offsetHeight / 2;
      const bx = b.offsetLeft, by = b.offsetTop + b.offsetHeight / 2;
      const mx = (ax + bx) / 2;
      const dim = a.classList.contains("filtered-out") || b.classList.contains("filtered-out");
      paths += `<path class="${dim ? "edge-dim" : ""}" marker-end="url(#arrow)" d="M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}" />`;
    }
  }
  edgesEl.innerHTML =
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
       <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--edge)" /></marker></defs>${paths}`;
}

function animateEdges(ms = 650) {
  const start = performance.now();
  const loop = (t) => { redrawEdges(); if (t - start < ms) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

/* ---------------- board status (viewer loading / error) ---------------- */

function showBoardStatus(html) {
  const el = $("#board-status");
  el.innerHTML = html;
  el.hidden = false;
  $("#empty-state").hidden = true;
}
function clearBoardStatus() { $("#board-status").hidden = true; }

/* ---------------- rendering: board ---------------- */

function render() {
  board.querySelectorAll(".project-card").forEach((el) => el.remove());
  const statusActive = !$("#board-status").hidden;
  $("#empty-state").hidden = viewerMode || statusActive || state.projects.length > 0;

  state.projects.forEach((p, i) => {
    const card = document.createElement("article");
    card.className = "project-card";
    card.dataset.id = p.id;
    card.style.setProperty("--x", `${p.x ?? CARD_GAP}px`);
    card.style.setProperty("--y", `${p.y ?? CARD_GAP}px`);
    card.style.setProperty("--card-accent", p.color || COLORS[0]);
    card.style.animationDelay = `${Math.min(i * 60, 400)}ms`;

    const entries = projectUpdates(p.id);
    const updates = entries.filter((u) => !isGoalEntry(u));
    const last = entries[entries.length - 1];
    const previewItems = updates.slice(-3).reverse();
    const linkCount = (p.parents?.length ?? 0) + childrenOf(p.id).length;
    const resCount = p.resources?.length ?? 0;

    card.innerHTML = `
      <div class="card-top">
        <span class="status-pill status-${p.status}">${STATUS_LABELS[p.status] ?? p.status}</span>
        <span class="card-badges">
          ${resCount ? `<span class="card-mini-badge card-res-badge" title="${resCount} resource(s)">
            <svg viewBox="0 0 24 24"><path d="M9.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>${resCount}</span>` : ""}
          ${linkCount ? `<span class="card-mini-badge card-link-badge" title="Linked to ${linkCount} project(s)">
            <svg viewBox="0 0 24 24"><path d="M9 12h6M8 8a4 4 0 0 0 0 8h2m4-8h2a4 4 0 0 1 0 8h-2"/></svg>${linkCount}</span>` : ""}
        </span>
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
          ? `<ul>${previewItems.map((u) => `<li><time>${fmtFull(u.created_at)}</time>${escapeHtml(u.body)}</li>`).join("")}</ul>`
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

/* ---------------- drag / click ---------------- */

function attachCard(card, project) {
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const stacked = window.matchMedia("(max-width: 720px)").matches;

    if (viewerMode || stacked) {
      const upOnce = () => { openDetail(project.id); window.removeEventListener("pointerup", upOnce); };
      window.addEventListener("pointerup", upOnce, { once: true });
      return;
    }

    const startX = e.clientX, startY = e.clientY;
    const origX = project.x ?? 0, origY = project.y ?? 0;
    let moved = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
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

  // resources
  const resBlock = $("#detail-resources");
  if (p.resources?.length) {
    resBlock.hidden = false;
    $("#detail-resources-body").innerHTML = resourceChips(p.resources);
  } else {
    resBlock.hidden = true;
  }

  // linked projects
  renderLinks(p);

  // timeline (updates + goals)
  const entries = projectUpdates(p.id);
  $("#update-count").textContent = entries.length;
  const timeline = $("#timeline");
  timeline.innerHTML = entries.length
    ? entries.map((u, i) => {
        const goal = isGoalEntry(u);
        return `
        <li class="timeline-item ${goal ? "goal" : ""}" style="animation-delay:${Math.min(i * 40, 300)}ms">
          <time datetime="${u.created_at}">${fmtFull(u.created_at)}</time>
          <div class="update-body">${goal ? `<span class="entry-tag">Goal</span>` : ""}${escapeHtml(u.body)}${resourceChips(u.resources)}<button class="update-delete" data-update="${u.id}" title="Delete entry">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button></div>
        </li>`;
      }).join("")
    : `<li class="timeline-empty">Nothing logged yet.${viewerMode ? "" : " Add an update or set a next step."}</li>`;
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
  composerResEditor.set([]);
  ta.focus();
  composer.scrollIntoView({ behavior: "smooth", block: "end" });
}

function closeComposer() {
  $("#composer").hidden = true;
  $("#add-update-btn").hidden = false;
}

async function saveUpdate() {
  const body = $("#composer-text").value.trim();
  const resources = composerResEditor.get();
  if ((!body && !resources.length) || !openProjectId) return;
  const update = {
    id: uid(), project_id: openProjectId, body, kind: "update",
    resources, created_at: new Date().toISOString(),
  };
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
  const prev = (p.next_step ?? "").trim();
  const next = $("#nextstep-input").value.trim();
  p.next_step = next;
  const goal = (next && next !== prev) ? makeGoal(p.id, next) : null;
  if (goal) state.updates.push(goal);
  renderDetail();
  render();
  try {
    await backend.upsertProject(p);
    if (goal) await backend.addUpdate(goal);
  } catch (err) { syncFail(err); }
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
  projectResEditor.set(project?.resources ?? []);
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
  const resources = projectResEditor.get();
  const existing = byId(editingProjectId);
  const prevNext = (existing?.next_step ?? "").trim();

  const project = existing
    ? { ...existing, name, description: $("#f-desc").value.trim(), next_step: $("#f-next").value.trim(),
        status: $("#f-status").value, color, tags, parents, resources }
    : {
        id: uid(), name,
        description: $("#f-desc").value.trim(),
        next_step: $("#f-next").value.trim(),
        status: $("#f-status").value,
        color, tags, parents, resources,
        ...nextFreePosition(),
        created_at: new Date().toISOString(),
      };

  if (existing) Object.assign(existing, project);
  else state.projects.push(project);

  const goal = (project.next_step && project.next_step !== prevNext)
    ? makeGoal(project.id, project.next_step) : null;
  if (goal) state.updates.push(goal);

  $("#project-modal").hidden = true;
  render();
  if (openProjectId) renderDetail();
  try {
    await backend.upsertProject(project);
    if (goal) await backend.addUpdate(goal);
  } catch (err) { syncFail(err); }
}

/* ---------------- ideas ---------------- */

function openIdeasDrawer() {
  renderIdeas();
  $("#ideas-drawer").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeIdeasDrawer() {
  $("#ideas-drawer").hidden = true;
  if ($("#detail-overlay").hidden) document.body.style.overflow = "";
}

function renderIdeas() {
  const list = $("#ideas-list");
  const ideas = [...state.ideas].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  $("#ideas-empty").hidden = ideas.length > 0;
  list.innerHTML = ideas.map((idea) => `
    <article class="idea-card" style="--idea-c:${idea.color || "#ffc36c"}">
      <div class="idea-top">
        <h3>${escapeHtml(idea.title)}</h3>
        <div class="idea-actions">
          <button class="icon-btn sm" data-promote="${idea.id}" title="Turn into a project">
            <svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button>
          <button class="icon-btn sm" data-edit-idea="${idea.id}" title="Edit">
            <svg viewBox="0 0 24 24"><path d="M17 3.5 20.5 7 8.5 19H5v-3.5Z"/></svg></button>
          <button class="icon-btn sm danger" data-del-idea="${idea.id}" title="Delete">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
      ${idea.body ? `<p class="idea-body">${escapeHtml(idea.body)}</p>` : ""}
      <time class="idea-date">${fmtDate(idea.created_at)}</time>
    </article>`).join("");
}

function openIdeaModal(idea = null) {
  editingIdeaId = idea?.id ?? null;
  $("#idea-modal-title").textContent = idea ? "Edit idea" : "New idea";
  $("#idea-save-btn").textContent = idea ? "Save changes" : "Create idea";
  $("#i-title").value = idea?.title ?? "";
  $("#i-body").value = idea?.body ?? "";
  buildSwatches($("#i-colors"), idea?.color ?? "#ffc36c");
  $("#idea-modal").hidden = false;
  $("#i-title").focus();
}

async function submitIdea(e) {
  e.preventDefault();
  const title = $("#i-title").value.trim();
  if (!title) return;
  const color = $("#i-colors .swatch.selected")?.dataset.color ?? "#ffc36c";
  const existing = state.ideas.find((x) => x.id === editingIdeaId);
  const idea = existing
    ? { ...existing, title, body: $("#i-body").value.trim(), color }
    : { id: uid(), title, body: $("#i-body").value.trim(), color, created_at: new Date().toISOString() };
  if (existing) Object.assign(existing, idea);
  else state.ideas.push(idea);
  $("#idea-modal").hidden = true;
  renderIdeas();
  try { await backend.upsertIdea(idea); } catch (err) { syncFail(err); }
}

async function deleteIdea(id) {
  const idea = state.ideas.find((x) => x.id === id);
  if (!idea) return;
  const ok = await confirmDanger(`Delete idea “${idea.title}”?`, "This idea will be removed. This cannot be undone.");
  if (!ok) return;
  state.ideas = state.ideas.filter((x) => x.id !== id);
  renderIdeas();
  try { await backend.deleteIdea(id); } catch (err) { syncFail(err); }
}

async function promoteIdea(id) {
  const idea = state.ideas.find((x) => x.id === id);
  if (!idea) return;
  const ok = await confirmDanger(
    `Turn “${idea.title}” into a project?`,
    "The idea moves onto your board as a new project and leaves the idea bin.",
    "Create project"
  );
  if (!ok) return;
  const project = normalizeProject({
    id: uid(), name: idea.title, description: idea.body, status: "planning",
    color: idea.color, ...nextFreePosition(), created_at: new Date().toISOString(),
  });
  state.projects.push(project);
  state.ideas = state.ideas.filter((x) => x.id !== id);
  renderIdeas();
  render();
  try {
    await backend.upsertProject(project);
    await backend.deleteIdea(id);
  } catch (err) { syncFail(err); }
  closeIdeasDrawer();
  openDetail(project.id);
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
  const payload = b64urlEncode(JSON.stringify({ u: cfg.url, k: cfg.key }));
  return `${location.origin}${location.pathname}?view=${payload}`;
}

function parseViewParam() {
  const raw = new URLSearchParams(location.search).get("view");
  if (!raw) return null;
  try {
    const { u, k } = JSON.parse(b64urlDecode(raw));
    if (u && k) return { url: u, key: k };
  } catch { /* malformed */ }
  return null;
}

function openShareModal() {
  const link = buildShareLink();
  if (link) {
    $("#share-link").value = link;
    $("#share-ready").hidden = false;
    $("#share-needs-sync").hidden = true;
    $("#share-connect").hidden = true;
  } else {
    $("#share-ready").hidden = true;
    $("#share-needs-sync").hidden = false;
    $("#share-connect").hidden = false;
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

function ingest(data) {
  state = {
    projects: (data.projects ?? []).map(normalizeProject),
    updates: (data.updates ?? []).map(normalizeUpdate),
    ideas: (data.ideas ?? []).map(normalizeIdea),
  };
}

let reloadTimer = null;
function scheduleRealtimeReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      ingest(await backend.loadAll());
      if (viewerMode) refreshViewerStatus();
      render();
      if (!$("#ideas-drawer").hidden) renderIdeas();
      if (openProjectId) { byId(openProjectId) ? renderDetail() : closeDetail(); }
    } catch (err) { syncFail(err); }
  }, 350);
}

function subscribeRealtime() {
  if (backend.kind !== "supabase") return;
  backend.subscribe(scheduleRealtimeReload);
}

function refreshViewerStatus() {
  if (!viewerMode) return;
  if (state.projects.length === 0) {
    showBoardStatus(`<div class="empty-orb"></div><h2>Nothing shared yet</h2>
      <p>This board doesn't have any projects on it right now.</p>`);
  } else {
    clearBoardStatus();
  }
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
        "Upload local data?",
        `Your Supabase tables are empty. Copy your ${state.projects.length} local project(s), their updates and ideas to the cloud?`,
        "Upload"
      );
      if (push) {
        for (const p of state.projects) await sb.upsertProject(p);
        for (const u of state.updates) await sb.addUpdate(u);
        for (const i of state.ideas) await sb.upsertIdea(i);
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
  projectResEditor = new ResourceEditor($("#f-resources"));
  composerResEditor = new ResourceEditor($("#composer-resources"));

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

  // detail
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

  // ideas
  $("#ideas-btn").addEventListener("click", openIdeasDrawer);
  $("#new-idea-btn").addEventListener("click", () => openIdeaModal());
  $("#idea-form").addEventListener("submit", submitIdea);
  $("#i-colors").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    $("#i-colors .selected")?.classList.remove("selected");
    sw.classList.add("selected");
  });
  $("#ideas-list").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit-idea]");
    const del = e.target.closest("[data-del-idea]");
    const pro = e.target.closest("[data-promote]");
    if (ed) openIdeaModal(state.ideas.find((x) => x.id === ed.dataset.editIdea));
    else if (del) deleteIdea(del.dataset.delIdea);
    else if (pro) promoteIdea(pro.dataset.promote);
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
    else if (which === "ideas-drawer") closeIdeasDrawer();
    else $(`#${which}`).hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#confirm-modal").hidden) $("#confirm-no").click();
    else if (!$("#idea-modal").hidden) $("#idea-modal").hidden = true;
    else if (!$("#project-modal").hidden) $("#project-modal").hidden = true;
    else if (!$("#appearance-modal").hidden) $("#appearance-modal").hidden = true;
    else if (!$("#share-modal").hidden) $("#share-modal").hidden = true;
    else if (!$("#sync-modal").hidden) $("#sync-modal").hidden = true;
    else if (!$("#ideas-drawer").hidden) closeIdeasDrawer();
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
    viewerMode = true;
    document.body.classList.add("viewer");
    $("#viewer-banner").hidden = false;
    showBoardStatus(`<div class="empty-orb"></div><h2>Connecting…</h2><p>Loading the shared board.</p>`);
    try {
      backend = await connectSupabase(view.url, view.key, true);
      ingest(await backend.loadAll());
      subscribeRealtime();
      refreshViewerStatus();
    } catch (err) {
      showBoardStatus(`<h2>Couldn't load the shared board</h2>
        <p>${escapeHtml(err.message)}</p>
        <p class="board-status-hint">Check that the share link is complete and that the Supabase project is reachable.</p>`);
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
