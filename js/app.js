/* ============================================================
   Orbit — app logic
   ============================================================ */

import {
  uid, initBackend, localBackend, connectSupabase,
  getSyncConfig, saveSyncConfig,
} from "./store.js";

const COLORS = ["#7c6cff", "#ff6cab", "#3ddc97", "#6cb8ff", "#ffc36c", "#ff8a5c", "#b39bff", "#5ce8e0"];
const STATUS_LABELS = { planning: "Planning", active: "Active", paused: "On hold", done: "Done" };

const CARD_W = 290;
const CARD_GAP = 28;

let backend = localBackend();
let state = { projects: [], updates: [] };
let openProjectId = null;   // project shown in the detail overlay
let editingProjectId = null; // project being edited in the form (null = creating)

const $ = (sel) => document.querySelector(sel);
const board = $("#board");

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

function projectUpdates(id) {
  return state.updates
    .filter((u) => u.project_id === id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
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
  }, 2400);
}

/* ---------------- board layout ---------------- */

function gridPositions(count) {
  const usable = Math.max(board.clientWidth - CARD_GAP, CARD_W);
  const cols = Math.max(1, Math.floor(usable / (CARD_W + CARD_GAP)));
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push({
      x: CARD_GAP + (i % cols) * (CARD_W + CARD_GAP),
      y: CARD_GAP + Math.floor(i / cols) * 230,
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
  board.style.minHeight = `${Math.max(maxY + 320, window.innerHeight - 65)}px`;
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

    card.innerHTML = `
      <div class="card-top">
        <span class="status-pill status-${p.status}">${STATUS_LABELS[p.status] ?? p.status}</span>
      </div>
      <h3 class="card-title">${escapeHtml(p.name)}</h3>
      <p class="card-desc">${escapeHtml(p.description)}</p>
      <div class="tag-row">${(p.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-foot">
        <span class="updates-chip">
          <svg viewBox="0 0 24 24"><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9" fill="none"/></svg>
          ${updates.length} update${updates.length === 1 ? "" : "s"}
        </span>
        <span>${last ? `updated ${fmtRelative(last.created_at)}` : `created ${fmtRelative(p.created_at)}`}</span>
      </div>
      <div class="card-preview">
        <h4>Latest updates</h4>
        ${previewItems.length
          ? `<ul>${previewItems.map((u) => `
              <li><time>${fmtFull(u.created_at)}</time>${escapeHtml(u.body)}</li>`).join("")}</ul>`
          : `<p class="preview-empty">No updates yet — click to add the first one.</p>`}
        <p class="preview-hint">Click to open · drag to move</p>
      </div>`;

    makeDraggable(card, p);
    board.appendChild(card);
  });

  applySearch();
  fitBoardHeight();
}

/* ---------------- drag / click handling ---------------- */

function makeDraggable(card, project) {
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // On small screens the cards are stacked statically — treat as click only.
    const stacked = window.matchMedia("(max-width: 720px)").matches;

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = project.x ?? 0;
    const origY = project.y ?? 0;
    let moved = false;

    const onMove = (ev) => {
      if (stacked) return;
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
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        card.classList.remove("dragging");
        fitBoardHeight();
        backend.savePosition(project.id, project.x, project.y).catch(syncFail);
      } else {
        openDetail(project.id);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function autoArrange() {
  const grid = gridPositions(state.projects.length);
  state.projects.forEach((p, i) => {
    p.x = grid[i].x;
    p.y = grid[i].y;
    const card = board.querySelector(`.project-card[data-id="${p.id}"]`);
    if (card) {
      card.style.setProperty("--x", `${p.x}px`);
      card.style.setProperty("--y", `${p.y}px`);
    }
  });
  fitBoardHeight();
  backend.savePositions(state.projects.map(({ id, x, y }) => ({ id, x, y }))).catch(syncFail);
}

/* ---------------- search ---------------- */

function applySearch() {
  const q = $("#search").value.trim().toLowerCase();
  board.querySelectorAll(".project-card").forEach((card) => {
    const p = state.projects.find((p) => p.id === card.dataset.id);
    const hay = `${p.name} ${p.description} ${(p.tags ?? []).join(" ")}`.toLowerCase();
    card.classList.toggle("filtered-out", q !== "" && !hay.includes(q));
  });
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
  openProjectId = null;
  document.body.style.overflow = "";
}

function renderDetail() {
  const p = state.projects.find((p) => p.id === openProjectId);
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
    : `<li class="timeline-empty">No updates yet. Log your first one below.</li>`;
}

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
  try {
    await backend.addUpdate(update);
  } catch (err) { syncFail(err); }
}

/* ---------------- project create / edit ---------------- */

function buildSwatches(selected) {
  $("#f-colors").innerHTML = COLORS.map((c) => `
    <button type="button" class="swatch ${c === selected ? "selected" : ""}"
            style="--c:${c}" data-color="${c}" aria-label="Accent ${c}"></button>`).join("");
}

function openProjectModal(project = null) {
  editingProjectId = project?.id ?? null;
  $("#project-modal-title").textContent = project ? "Edit project" : "New project";
  $("#project-save-btn").textContent = project ? "Save changes" : "Create project";
  $("#f-name").value = project?.name ?? "";
  $("#f-desc").value = project?.description ?? "";
  $("#f-status").value = project?.status ?? "active";
  $("#f-tags").value = (project?.tags ?? []).join(", ");
  buildSwatches(project?.color ?? COLORS[state.projects.length % COLORS.length]);
  $("#project-modal").hidden = false;
  $("#f-name").focus();
}

async function submitProject(e) {
  e.preventDefault();
  const name = $("#f-name").value.trim();
  if (!name) return;

  const color = $("#f-colors .swatch.selected")?.dataset.color ?? COLORS[0];
  const tags = $("#f-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const existing = state.projects.find((p) => p.id === editingProjectId);

  const project = existing
    ? { ...existing, name, description: $("#f-desc").value.trim(), status: $("#f-status").value, color, tags }
    : {
        id: uid(), name,
        description: $("#f-desc").value.trim(),
        status: $("#f-status").value,
        color, tags,
        ...nextFreePosition(),
        created_at: new Date().toISOString(),
      };

  if (existing) Object.assign(existing, project);
  else state.projects.push(project);

  $("#project-modal").hidden = true;
  render();
  if (openProjectId) renderDetail();
  try {
    await backend.upsertProject(project);
  } catch (err) { syncFail(err); }
}

/* ---------------- confirm dialog ---------------- */

function confirmDanger(title, sub) {
  return new Promise((resolve) => {
    $("#confirm-text").textContent = title;
    $("#confirm-sub").textContent = sub;
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

/* ---------------- sync (Supabase) ---------------- */

function syncFail(err) {
  console.error(err);
  toast(`Sync error: ${err.message ?? err}`);
}

function refreshSyncLabel() {
  $("#sync-label").textContent = backend.kind === "supabase" ? "Synced" : "Local";
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

    // First connect with an empty cloud DB: offer to push local data up.
    if (remote.projects.length === 0 && state.projects.length > 0) {
      const push = await confirmDanger(
        "Upload local projects?",
        `Your Supabase tables are empty. Copy your ${state.projects.length} local project(s) and their updates to the cloud?`
      );
      if (push) {
        for (const p of state.projects) await sb.upsertProject(p);
        for (const u of state.updates) await sb.addUpdate(u);
      }
    }

    backend = sb;
    saveSyncConfig({ url, key });
    state = await backend.loadAll();
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
  saveSyncConfig(null);
  backend = localBackend();
  state = await backend.loadAll();
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

  $("#edit-project-btn").addEventListener("click", () => {
    const p = state.projects.find((p) => p.id === openProjectId);
    if (p) openProjectModal(p);
  });

  $("#delete-project-btn").addEventListener("click", async () => {
    const p = state.projects.find((p) => p.id === openProjectId);
    if (!p) return;
    const ok = await confirmDanger(
      `Delete “${p.name}”?`,
      "The project and all of its updates will be removed. This cannot be undone."
    );
    if (!ok) return;
    state.projects = state.projects.filter((x) => x.id !== p.id);
    state.updates = state.updates.filter((u) => u.project_id !== p.id);
    closeDetail();
    render();
    try { await backend.deleteProject(p.id); } catch (err) { syncFail(err); }
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
    else if (!$("#sync-modal").hidden) $("#sync-modal").hidden = true;
    else if (!$("#detail-overlay").hidden) closeDetail();
  });

  window.addEventListener("resize", fitBoardHeight);
}

/* ---------------- boot ---------------- */

async function boot() {
  wire();
  const { backend: be, syncError } = await initBackend();
  backend = be;
  if (syncError) toast(`Supabase unreachable — using local data (${syncError})`);
  refreshSyncLabel();
  try {
    state = await backend.loadAll();
  } catch (err) {
    syncFail(err);
    backend = localBackend();
    state = await backend.loadAll();
    refreshSyncLabel();
  }
  render();
}

boot();
