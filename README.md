# KCL Wind — Cricket Auction Portal

A clean, white & red themed multi-page website for managing a cricket auction:

- **Home** (`index.html`) — dashboard linking to all sections
- **Tournament** (`tournament.html`) — name, ground, date & time
- **Auction** (`auction.html`) — name, date & time
- **My Tournament** (`my-tournament.html`) — your team, captain, budget
- **My Auction** (`my-auction.html`) — your auction team, purse, status
- **Notes** (`notes.html`) — private per-owner strategy notes (owner-only)
- **Teams** (`teams.html`) — add/edit/delete teams with owner/captain
- **Players** (`players.html`) — add/edit/delete players with role & base price
- **Links** (`links.html`) — important URLs (rules, streaming, payments, etc.)

All pages share `styles.css` and `app.js`; data persists in `localStorage` across pages.

## Login & roles

`login.html` is the entry point — email-based sign-in (demo mode, no passwords):

- **Admin** — `kcladmin@gmail.com` only; can edit everything.
- **Team Owners** — `vignesh12@gmail.com`, `shashi34@gmail.com`, `aravinth56@gmail.com`, `dilip78@gmail.com`; view-only everywhere, but can add/edit/delete their own private **Notes** (auction strategy). Each owner's notes are private to their login email.
- **Audience** — tap "Continue as Audience" (no email needed); view-only, all edit controls hidden.

Registered emails are defined in `login.html`. Permissions are defined in `ROLE_PERMS` at the top of `app.js`. The session is stored in `localStorage` under `kclwind_session`; use **Logout** in the nav to switch accounts. When you add a real backend, move the email list and auth server-side.

## Database / live sync (Supabase)

The app works with `localStorage` by default. To sync across devices (needed for the live auction mirror on phones/other laptops), set up Supabase:

1. Go to **https://supabase.com** → **New project** (free tier).
2. Open **SQL Editor** and run:

```sql
create table if not exists app_state (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
insert into app_state (id, data) values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table app_state enable row level security;
create policy "public read"   on app_state for select using (true);
create policy "public insert" on app_state for insert with check (true);
create policy "public update" on app_state for update using (true);

alter publication supabase_realtime add table app_state;
```

3. **Project Settings → API** → copy **Project URL** and **anon public key**.
4. Paste them into `SUPABASE_CONFIG` at the top of `app.js` (replace `PASTE_...`).

Once configured:
- All data (tournament, teams, players, auction state, notes) syncs to Supabase on every save.
- `live.html` viewers get **real-time** updates via Supabase Realtime — the auction stage mirrors instantly on any device.
- First device to open the site seeds the database; others pull remote data on load.

> The anon key + open policies are fine for your private event. If the site goes fully public, tighten RLS policies.

## Run locally

No build step needed — it's plain HTML/CSS/JS.

```powershell
# Option 1: just open index.html in a browser
# Option 2: serve it
python -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a new repo on GitHub (e.g. `kcl-wind-auction`).
2. Push these files:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/kcl-wind-auction.git
git push -u origin main
```

3. In the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. Your site will be live at `https://<you>.github.io/kcl-wind-auction/` in ~1 minute.

## Database

Data is currently stored in the browser's `localStorage` (key: `kclwind_db_v1`).

To connect a real database later:

- The data layer is isolated in `app.js` — `loadDB()` / `saveDB()`.
- Replace those two functions with `fetch()` calls to your API (e.g. Firebase, Supabase, or a Node/Express backend).
- The JSON shape is flat and portable:

```json
{
  "tournament": { "name": "", "ground": "", "datetime": "" },
  "auction":    { "name": "", "datetime": "" },
  "teams":    [{ "id": "", "name": "", "owner": "" }],
  "players":  [{ "id": "", "name": "", "role": "", "basePrice": 0 }],
  "links":    [{ "id": "", "title": "", "url": "" }]
}
```

> Note: `localStorage` is per-browser — viewers of your public link won't see your edits.
> Once you add a backend, all visitors will share the same live data.
