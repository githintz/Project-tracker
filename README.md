# Orbit — Project Tracker

A clean, modern, single-page board for tracking progress and updates across all
your projects. No build step, no framework — just static HTML/CSS/JS, so it runs
perfectly on GitHub Pages.

## Features

- **Project board (“map”)** — every project is a card on a free-form board.
  Drag cards anywhere to arrange them your way; positions are remembered.
  Hit **Arrange** in the top bar to snap everything back into a tidy grid.
- **Hover previews** — hovering a card shows its three most recent updates.
- **Project detail** — click a card to expand it: full description, tags,
  status, and a timeline of every update with its date and time.
- **＋ New update** — the button at the end of each timeline logs a new update,
  timestamped automatically. (`Ctrl/⌘ + Enter` saves quickly.)
- **Create / edit / delete projects** — name, description, status
  (Planning / Active / On hold / Done), tags, and an accent colour.
- **Search** — filter the board live by name, description, or tag.
- **Storage** — works out of the box with browser localStorage; optionally
  connect Supabase to sync across devices.

## Hosting on GitHub Pages

Two options — pick one:

**Option A — deploy from branch (simplest)**

1. Merge this code to `main`.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set *Source* to **Deploy from a branch**,
   choose `main` and `/ (root)`, then save.
4. Your tracker will be live at `https://<username>.github.io/<repo>/` in a
   minute or two.

**Option B — GitHub Actions (already included)**

This repo ships with `.github/workflows/deploy-pages.yml`. In
**Settings → Pages**, set *Source* to **GitHub Actions**. Every push to `main`
then deploys automatically.

## Optional: sync across devices with Supabase

By default everything is stored in your browser (localStorage), which means
data stays on one device. To sync across devices:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase dashboard, open **SQL Editor** and run:

   ```sql
   create table projects (
     id          uuid primary key,
     name        text not null,
     description text default '',
     status      text default 'active',
     color       text default '#7c6cff',
     tags        text[] default '{}',
     x           double precision default 0,
     y           double precision default 0,
     created_at  timestamptz default now()
   );

   create table updates (
     id          uuid primary key,
     project_id  uuid not null references projects (id) on delete cascade,
     body        text not null,
     created_at  timestamptz default now()
   );

   -- Personal single-user tracker: allow the anon key full access.
   -- Anyone with your anon key can read/write these tables, so don't
   -- share the key (or add Supabase Auth + stricter policies later).
   alter table projects enable row level security;
   alter table updates  enable row level security;
   create policy "anon full access" on projects for all using (true) with check (true);
   create policy "anon full access" on updates  for all using (true) with check (true);
   ```

3. In Orbit, click the **Local** button in the top bar, paste your project URL
   and anon (public) key from **Settings → API**, and hit **Connect**.
   If your cloud tables are empty, Orbit offers to upload your local data.

The connection details are stored in your browser; click the same button to
disconnect and fall back to local storage at any time.

## Development

It's all static — serve the folder with anything:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Note: ES modules require http://, so opening `index.html` via `file://` won't work.)
