# Orbit — Project Tracker

A clean, modern, single-page board for tracking progress and updates across all
your projects. No build step, no framework — just static HTML/CSS/JS, so it runs
perfectly on GitHub Pages.

## Features

- **Project board (“map”)** — every project is a card on a free-form board.
  Drag cards anywhere to arrange them your way; positions are remembered.
- **Project timeline / links** — mark a project as *following from* one or more
  earlier projects (e.g. a finished project that feeds into its follow-ups).
  Connections are drawn as arrows between cards, and **Arrange** lays linked
  projects out as a left-to-right **tree** (it falls back to a tidy grid when
  nothing is linked).
- **Next step / goals** — each project has a “next step” so you always know what
  you want to do next, editable inline from the detail view or in the project
  form. Whenever you set or change it, the goal is also logged into the project
  timeline (in the accent colour, so goals stand apart from progress updates).
- **Resources** — save links (papers, docs, references) on a project, and attach
  links to an individual update too. They show as clickable chips in the detail
  view and timeline.
- **Idea bin** — a separate place to park ideas for the future (open it from the
  top bar). Each idea is a quick note with a colour; promote one to a full
  project on your board whenever it's ready.
- **Hover previews** — hovering a card shows its next step and three most recent
  updates.
- **Project detail** — click a card to expand it: full description, tags,
  status, linked projects, and a timeline of every update with date and time.
- **＋ New update** — the button at the end of each timeline logs a new update,
  timestamped automatically. (`Ctrl/⌘ + Enter` saves quickly.)
- **Create / edit / delete projects** — name, description, next step, status
  (Planning / Active / On hold / Done), tags, links, and an accent colour.
- **Light & dark themes + custom accent** — the palette button in the top bar
  opens Appearance: switch theme and pick any accent colour. Remembered locally.
- **Search** — filter the board live by name, description, next step, or tag.
- **Share (read-only, real-time)** — invite someone (e.g. a supervisor) to a
  live, read-only view of your board via a link. Requires Supabase (below).
- **Storage** — works out of the box with browser localStorage; optionally
  connect Supabase to sync across devices and enable sharing.

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

> If a deploy is rejected with *“Branch main is not allowed to deploy to
> github-pages due to environment protection rules”*, set the Pages *Source* to
> **GitHub Actions** (which recreates the environment with `main` allowed), or
> add a `main` rule under **Settings → Environments → github-pages →
> Deployment branches**.

## Optional: cloud sync, sharing & real-time updates with Supabase

By default everything is stored in your browser (localStorage), which means
data stays on one device and sharing is unavailable. To sync across devices and
enable real-time read-only sharing:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase dashboard, open **SQL Editor** and run:

   ```sql
   create table projects (
     id          uuid primary key,
     name        text not null,
     description text default '',
     next_step   text default '',
     status      text default 'active',
     color       text default '#7c6cff',
     tags        text[] default '{}',
     parents     uuid[] default '{}',   -- ids of projects this one follows from
     resources   jsonb default '[]',    -- [{ url, title }]
     x           double precision default 0,
     y           double precision default 0,
     created_at  timestamptz default now()
   );

   create table updates (
     id          uuid primary key,
     project_id  uuid not null references projects (id) on delete cascade,
     body        text not null,
     kind        text default 'update',   -- 'update' or 'goal'
     resources   jsonb default '[]',      -- [{ url, title }]
     created_at  timestamptz default now()
   );

   create table ideas (
     id          uuid primary key,
     title       text not null,
     body        text default '',
     color       text default '#ffc36c',
     created_at  timestamptz default now()
   );

   -- Personal single-user tracker: allow the anon key full access.
   -- Anyone with your anon key can read/write these tables, so don't
   -- share the key publicly (see "Locking down sharing" below).
   alter table projects enable row level security;
   alter table updates  enable row level security;
   alter table ideas    enable row level security;
   create policy "anon full access" on projects for all using (true) with check (true);
   create policy "anon full access" on updates  for all using (true) with check (true);
   create policy "anon full access" on ideas    for all using (true) with check (true);

   -- Enable real-time so shared viewers (and your other devices) update live.
   alter publication supabase_realtime add table projects;
   alter publication supabase_realtime add table updates;
   alter publication supabase_realtime add table ideas;
   ```

   **Already had an earlier version of the tables?** Add what's new (each line is
   safe to run even if it already exists):

   ```sql
   alter table projects add column if not exists next_step text default '';
   alter table projects add column if not exists parents   uuid[] default '{}';
   alter table projects add column if not exists resources jsonb default '[]';
   alter table updates  add column if not exists kind      text default 'update';
   alter table updates  add column if not exists resources jsonb default '[]';

   create table if not exists ideas (
     id uuid primary key, title text not null, body text default '',
     color text default '#ffc36c', created_at timestamptz default now()
   );
   alter table ideas enable row level security;
   create policy "anon full access" on ideas for all using (true) with check (true);

   alter publication supabase_realtime add table projects;
   alter publication supabase_realtime add table updates;
   alter publication supabase_realtime add table ideas;
   ```

3. In Orbit, click the **Local** button in the top bar, paste your project URL
   and anon (public) key from **Settings → API**, and hit **Connect**.
   If your cloud tables are empty, Orbit offers to upload your local data.

The connection details are stored in your browser; click the same button to
disconnect and fall back to local storage at any time.

### Seeing your projects on another device (e.g. your phone)

Without Supabase, Orbit keeps data in the browser's localStorage, which is
**per-device** — so opening the plain site URL on your phone shows an empty board
("no projects") because that device has its own empty storage. To see your
projects on another device you have two options:

- **Connect that device to the same Supabase project** (top-bar **Local** button,
  same URL + anon key), or
- **Open a Share link** generated from the device that has your data — it carries
  the connection details, loads your board in real time, and works on mobile.

### Sharing your board (read-only)

Once connected to Supabase, click **Share** in the top bar to get a link. Anyone
who opens it sees a clean, **read-only** view of your projects and their latest
updates that refreshes in real time — ideal for keeping a supervisor up to date.

The viewer UI hides all editing controls. Note, however, that the link embeds
your Supabase **anon key**, so with the policies above a determined recipient
could technically write to the database. Treat the link like a password and only
share it with people you trust.

### Locking down sharing to true read-only (optional, recommended for wider sharing)

If you want the shared link to be genuinely read-only at the database level,
replace the “anon full access” policies with separate read/write roles. The
simplest robust approach is to keep writes behind Supabase Auth (so only your
signed-in session can write) while leaving anon `select` open:

```sql
drop policy "anon full access" on projects;
drop policy "anon full access" on updates;

-- anyone (incl. shared viewers) can read
create policy "public read" on projects for select using (true);
create policy "public read" on updates  for select using (true);

-- only authenticated users can write
create policy "auth write" on projects for all to authenticated using (true) with check (true);
create policy "auth write" on updates  for all to authenticated using (true) with check (true);
```

(This requires wiring up Supabase Auth for your own editing session, which is
beyond the default setup — open an issue if you'd like that added.)

## Development

It's all static — serve the folder with anything:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Note: ES modules require http://, so opening `index.html` via `file://` won't work.)
