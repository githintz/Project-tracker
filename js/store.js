/* ============================================================
   Storage layer.

   Two interchangeable backends:
     - LocalBackend    → localStorage, zero setup (default)
     - SupabaseBackend → cloud sync across devices (optional)

   Both expose the same async API:
     loadAll()                       → { projects, updates }
     upsertProject(project)
     deleteProject(id)               (also removes its updates)
     savePosition(id, x, y)
     savePositions([{id,x,y}, …])
     addUpdate(update)
     deleteUpdate(id)
   ============================================================ */

const LS_DATA_KEY = "orbit.data.v1";
const LS_SYNC_KEY = "orbit.supabase.v1";

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
        : { projects: [], updates: [] };
    } catch {
      this.data = { projects: [], updates: [] };
    }
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
}

/* ---------------- Supabase backend ----------------
   Expects two tables (see README.md for the SQL):
     projects(id uuid pk, name, description, status, color, tags text[], x, y, created_at)
     updates(id uuid pk, project_id uuid fk, body, created_at)
---------------------------------------------------- */

class SupabaseBackend {
  constructor(client) {
    this.kind = "supabase";
    this.client = client;
  }

  static async connect(url, anonKey) {
    const { createClient } = await import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    );
    const client = createClient(url, anonKey);
    // Probe both tables so a bad URL/key/schema fails here, not mid-use.
    const probe = await client.from("projects").select("id").limit(1);
    if (probe.error) throw new Error(probe.error.message);
    const probe2 = await client.from("updates").select("id").limit(1);
    if (probe2.error) throw new Error(probe2.error.message);
    return new SupabaseBackend(client);
  }

  async loadAll() {
    const [p, u] = await Promise.all([
      this.client.from("projects").select("*").order("created_at"),
      this.client.from("updates").select("*").order("created_at"),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (u.error) throw new Error(u.error.message);
    return { projects: p.data ?? [], updates: u.data ?? [] };
  }

  async upsertProject(project) {
    const { error } = await this.client.from("projects").upsert(project);
    if (error) throw new Error(error.message);
  }

  async deleteProject(id) {
    // updates are removed by the ON DELETE CASCADE foreign key
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

export async function connectSupabase(url, anonKey) {
  return SupabaseBackend.connect(url, anonKey);
}

export function localBackend() {
  return new LocalBackend();
}

/* Boot with Supabase when configured, falling back to local on failure. */
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
