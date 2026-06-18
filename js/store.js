/* ============================================================
   Storage layer.

   Two interchangeable backends:
     - LocalBackend    → localStorage, zero setup (default)
     - SupabaseBackend → cloud sync + realtime + sharing (optional)

   Shared async API:
     loadAll()                       → { projects, updates, ideas }
     upsertProject(project)
     deleteProject(id)               (also removes its updates)
     savePosition(id, x, y)
     savePositions([{id,x,y}, …])
     addUpdate(update)
     deleteUpdate(id)
     upsertIdea(idea) / deleteIdea(id)
     subscribe(onChange) / unsubscribe()   (realtime; local = no-op)
   ============================================================ */

const LS_DATA_KEY = "orbit.data.v1";
const LS_SYNC_KEY = "orbit.supabase.v1";

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/* ---- normalisers: guarantee shape regardless of backend / data age ---- */

export function normalizeProject(p) {
  return {
    ...p,
    description: p.description ?? "",
    status: p.status ?? "active",
    color: p.color ?? "#7c6cff",
    tags: Array.isArray(p.tags) ? p.tags : [],
    parents: Array.isArray(p.parents) ? p.parents : [],
    next_step: p.next_step ?? "",
    resources: Array.isArray(p.resources) ? p.resources : [],
    x: typeof p.x === "number" ? p.x : 0,
    y: typeof p.y === "number" ? p.y : 0,
  };
}

export function normalizeUpdate(u) {
  return {
    ...u,
    kind: u.kind ?? "update",
    resources: Array.isArray(u.resources) ? u.resources : [],
  };
}

export function normalizeIdea(i) {
  return {
    ...i,
    title: i.title ?? "",
    body: i.body ?? "",
    color: i.color ?? "#ffc36c",
  };
}

/* ---------------- localStorage backend ---------------- */

class LocalBackend {
  constructor() {
    this.kind = "local";
    this._read();
  }

  _read() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_DATA_KEY));
      this.data = raw && Array.isArray(raw.projects)
        ? raw
        : { projects: [], updates: [], ideas: [] };
    } catch {
      this.data = { projects: [], updates: [], ideas: [] };
    }
    if (!Array.isArray(this.data.ideas)) this.data.ideas = [];
  }

  _write() {
    localStorage.setItem(LS_DATA_KEY, JSON.stringify(this.data));
  }

  async loadAll() {
    this._read();
    return structuredClone(this.data);
  }

  async upsertProject(project) {
    const i = this.data.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) this.data.projects[i] = project;
    else this.data.projects.push(project);
    this._write();
  }

  async deleteProject(id) {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.data.updates = this.data.updates.filter((u) => u.project_id !== id);
    this._write();
  }

  async savePosition(id, x, y) {
    const p = this.data.projects.find((p) => p.id === id);
    if (p) { p.x = x; p.y = y; this._write(); }
  }

  async savePositions(list) {
    for (const { id, x, y } of list) {
      const p = this.data.projects.find((p) => p.id === id);
      if (p) { p.x = x; p.y = y; }
    }
    this._write();
  }

  async addUpdate(update) {
    this.data.updates.push(update);
    this._write();
  }

  async deleteUpdate(id) {
    this.data.updates = this.data.updates.filter((u) => u.id !== id);
    this._write();
  }

  async upsertIdea(idea) {
    const i = this.data.ideas.findIndex((x) => x.id === idea.id);
    if (i >= 0) this.data.ideas[i] = idea;
    else this.data.ideas.push(idea);
    this._write();
  }

  async deleteIdea(id) {
    this.data.ideas = this.data.ideas.filter((x) => x.id !== id);
    this._write();
  }

  subscribe() { /* no realtime for local storage */ }
  unsubscribe() {}
}

/* ---------------- Supabase backend ----------------
   Tables (see README.md for the SQL):
     projects(id, name, description, next_step, status, color, tags text[],
              parents uuid[], resources jsonb, x, y, created_at)
     updates(id, project_id fk, body, kind, resources jsonb, created_at)
     ideas(id, title, body, color, created_at)
---------------------------------------------------- */

class SupabaseBackend {
  constructor(client, readOnly = false) {
    this.kind = "supabase";
    this.client = client;
    this.readOnly = readOnly;
    this.channel = null;
  }

  static async connect(url, anonKey, readOnly = false) {
    const { createClient } = await import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    );
    const client = createClient(url, anonKey);
    const probe = await client.from("projects").select("id").limit(1);
    if (probe.error) throw new Error(probe.error.message);
    const probe2 = await client.from("updates").select("id").limit(1);
    if (probe2.error) throw new Error(probe2.error.message);
    return new SupabaseBackend(client, readOnly);
  }

  async loadAll() {
    const [p, u] = await Promise.all([
      this.client.from("projects").select("*").order("created_at"),
      this.client.from("updates").select("*").order("created_at"),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (u.error) throw new Error(u.error.message);
    // ideas table is optional / may not be migrated yet — tolerate its absence
    let ideas = [];
    const iq = await this.client.from("ideas").select("*").order("created_at");
    if (!iq.error) ideas = iq.data ?? [];
    return { projects: p.data ?? [], updates: u.data ?? [], ideas };
  }

  async upsertProject(project) {
    const { error } = await this.client.from("projects").upsert(project);
    if (error) throw new Error(error.message);
  }

  async deleteProject(id) {
    const { error } = await this.client.from("projects").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }

  async savePosition(id, x, y) {
    const { error } = await this.client.from("projects").update({ x, y }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  async savePositions(list) {
    await Promise.all(list.map(({ id, x, y }) => this.savePosition(id, x, y)));
  }

  async addUpdate(update) {
    const { error } = await this.client.from("updates").insert(update);
    if (error) throw new Error(error.message);
  }

  async deleteUpdate(id) {
    const { error } = await this.client.from("updates").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }

  async upsertIdea(idea) {
    const { error } = await this.client.from("ideas").upsert(idea);
    if (error) throw new Error(error.message);
  }

  async deleteIdea(id) {
    const { error } = await this.client.from("ideas").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }

  subscribe(onChange) {
    this.unsubscribe();
    this.channel = this.client
      .channel("orbit-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "updates" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "ideas" }, onChange)
      .subscribe();
  }

  unsubscribe() {
    if (this.channel) {
      this.client.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

/* ---------------- backend selection ---------------- */

export function getSyncConfig() {
  try {
    return JSON.parse(localStorage.getItem(LS_SYNC_KEY));
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg) {
  if (cfg) localStorage.setItem(LS_SYNC_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(LS_SYNC_KEY);
}

export async function connectSupabase(url, anonKey, readOnly = false) {
  return SupabaseBackend.connect(url, anonKey, readOnly);
}

export function localBackend() {
  return new LocalBackend();
}

export async function initBackend() {
  const cfg = getSyncConfig();
  if (cfg?.url && cfg?.key) {
    try {
      return { backend: await connectSupabase(cfg.url, cfg.key), syncError: null };
    } catch (err) {
      return { backend: new LocalBackend(), syncError: err.message };
    }
  }
  return { backend: new LocalBackend(), syncError: null };
}
