/* KCL Wind Auction — data layer.
 * Currently persists to localStorage. To move to a real database later,
 * replace the load()/save() calls with fetch() calls to your API endpoints.
 * Data shape is kept flat & JSON-friendly for easy migration.
 */

const DB_KEY = "kclwind_db_v1";
const SESSION_KEY = "kclwind_session";

/* ============================================================
 * SUPABASE (Postgres) — REALTIME DATABASE
 * ------------------------------------------------------------
 * 1. Go to https://supabase.com → New project (free tier)
 * 2. SQL Editor → run the setup SQL (see README)
 * 3. Project Settings → API → copy Project URL + anon public key
 * 4. Paste below, replacing PASTE_...
 * ============================================================ */
const SUPABASE_CONFIG = {
  url: "https://oaznjrsrkrxnsvqdrsxb.supabase.co",
  anonKey: "sb_publishable_tjNBTZUXSrpIvF1ZA2jYCw_z-Jm7nk7"
};

let sbClient = null;
let remoteSnapshot = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function isEmptyDB(d) {
  return !(d.teams || []).length && !(d.players || []).length && !(d.links || []).length &&
    !(d.notes || []).length && !(d.tournament && d.tournament.name) && !(d.auction && d.auction.name);
}

// Union of local+remote matches by id (remote wins on conflict); tombstoned ids stay deleted
function mergeMatches(local, remote, tomb) {
  const map = new Map();
  (local || []).forEach(m => { if (m && m.id && !tomb.has(m.id)) map.set(m.id, m); });
  (remote || []).forEach(m => { if (m && m.id && !tomb.has(m.id)) map.set(m.id, m); });
  return [...map.values()];
}
function mergeTombstones(a, b) {
  return [...new Set([...(a || []), ...(b || [])])].slice(-300);
}

async function initRemoteDB() {
  const c = SUPABASE_CONFIG;
  if (!c.url || c.url.startsWith("PASTE")) return; // not configured → localStorage only
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    sbClient = window.supabase.createClient(c.url, c.anonKey);
    const { data, error } = await sbClient
      .from("app_state").select("data").eq("id", 1).maybeSingle();
    if (error) throw error;
    if (data && data.data) {
      if (isEmptyDB(data.data) && !isEmptyDB(db)) {
        // Remote got wiped (e.g. empty seed from a fresh device) but this
        // browser still has data → restore remote from local.
        await sbClient.from("app_state").upsert({ id: 1, data: db });
        remoteSnapshot = db;
      } else if (data.data._ts && (db._ts || 0) > data.data._ts && !isEmptyDB(db)) {
        // Remote is older than our last local save, and local actually has
        // records → local wins. An empty browser must not wipe the shared DB.
        await sbClient.from("app_state").upsert({ id: 1, data: db });
        remoteSnapshot = db;
      } else {
        const tomb = new Set(mergeTombstones(db.deletedMatches, data.data.deletedMatches));
        Object.keys(data.data).forEach(k => {
          if (k === "_ts" || k === "_client") return; // write metadata — keep our own
          if (k === "matches") db.matches = mergeMatches(db.matches, data.data.matches, tomb);
          else if (k === "deletedMatches") db.deletedMatches = [...tomb];
          else if (k in db) db[k] = data.data[k];
        });
        if (data.data._ts) db._ts = Math.max(db._ts || 0, data.data._ts);
        // Heal remote if local had matches remote was missing
        if ((db.matches || []).length !== (data.data.matches || []).length) {
          sbClient.from("app_state").upsert({ id: 1, data: db }).then(() => {});
        }
        remoteSnapshot = db;
      }
    } else if (!isEmptyDB(db)) {
      // No remote row yet — seed it, but ONLY if local actually has data
      // (prevents a fresh device from wiping the shared DB with emptiness).
      await sbClient.from("app_state").upsert({ id: 1, data: db });
      remoteSnapshot = db;
    }
    // Cache the merged snapshot locally so the next visit paints instantly
    // from this cache — no network wait; the remote is still re-checked
    // in the background and will overwrite the cache if it is newer.
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch {}
  } catch (e) {
    console.warn("Supabase unavailable — using local storage only.", e);
    sbClient = null;
  }
}

/* ---------- Session / roles ---------- */
const session = (() => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
})();
if (!session) {
  location.href = "login.html";
}

// Which sections each role may edit. "admin" = everything except "My *" pages.
const ROLE_PERMS = {
  admin:    ["tournament", "auction", "teams", "players", "links"],
  owner:    ["notes"],
  audience: [],
};

// "My Tournament" / "My Auction" / "Notes" are owner-only pages.
const isOwnerOnlyPage = /my-(tournament|auction|team)\.html$|notes\.html$/.test(location.pathname);
if (session.role !== "owner" && isOwnerOnlyPage) {
  location.href = "index.html";
}

const defaultDB = {
  tournament: { name: "", ground: "", datetime: "" },
  auction: { name: "", datetime: "", tournament: "", live: false, liveAt: null, soldPlayers: [], unsoldPlayers: [] },
  myTournament: { team: "", captain: "", budget: 0 },
  myAuction: { team: "", purse: 0, status: "Registered" },
  teams: [],   // { id, name, owner }
  players: [], // { id, name, role, basePrice }
  links: [],   // { id, title, url }
  notes: [],   // { id, owner, text, updatedAt }
  matches: [], // { id, team1, team2, date, overs, venue, status, innings, currentInnings }
};

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return structuredClone(defaultDB);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(defaultDB), ...parsed };
  } catch {
    return structuredClone(defaultDB);
  }
}

/* Stable per-device id so a device can recognise (and ignore) the realtime echo
   of its OWN writes — on the scoring device the local state is the source of truth. */
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem("kclwind_client_id");
    if (!id) { id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem("kclwind_client_id", id); }
    return id;
  } catch { return "c" + Date.now().toString(36); }
})();

let upsertTimer = null;    // debounce: rapid balls coalesce into ONE write
let upsertBusy = false;    // serialize: only one write in flight at a time
let upsertQueued = false;  // a newer state arrived while a write was in flight

function pushRemote() {
  if (!sbClient) return;
  if (upsertBusy) { upsertQueued = true; return; }
  upsertBusy = true;
  const payload = JSON.parse(JSON.stringify(db)); // exact snapshot of the latest state
  const done = () => { upsertBusy = false; if (upsertQueued) { upsertQueued = false; pushRemote(); } };
  sbClient.from("app_state").upsert({ id: 1, data: payload }).then(done, done);
}

function saveDB(db) {
  // Stamp WHO wrote it and WHEN so receivers can ignore this device's echo and
  // never let an older snapshot overwrite a newer local one (last-write-wins).
  db._client = CLIENT_ID;
  db._ts = Date.now();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (sbClient) {
    clearTimeout(upsertTimer);
    upsertTimer = setTimeout(pushRemote, 300); // ~300ms debounce
  }
}

const db = loadDB();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function getTeamSquad(teamName, data = db) {
  return (data && Array.isArray(data.players) ? data.players : [])
    .filter(player => player.soldTo === teamName);
}

function assignPlayerToTeam(playerId, teamName) {
  const player = (db.players || []).find(item => item.id === playerId);
  if (!player) return null;

  (db.teams || []).forEach(team => {
    team.players = (Array.isArray(team.players) ? team.players : [])
      .filter(id => id !== playerId);
  });

  const assignedTeam = teamName === "— None —" ? "" : (teamName || "");
  player.soldTo = assignedTeam;
  player.team = assignedTeam;
  if (!assignedTeam) {
    player.soldPrice = 0;
    player.auctionBought = false;
    db.auction.soldPlayers = (db.auction.soldPlayers || []).filter(id => id !== playerId);
    db.auction.unsoldPlayers = (db.auction.unsoldPlayers || []).filter(id => id !== playerId);
    return player;
  }

  const team = (db.teams || []).find(item => item.name === assignedTeam);
  if (team) team.players.push(playerId);
  db.auction.unsoldPlayers = (db.auction.unsoldPlayers || []).filter(id => id !== playerId);
  return player;
}

function normalizePlayerTeams() {
  const changedPlayerIds = new Set();
  let changed = false;
  if (!Array.isArray(db.players)) {
    db.players = [];
    changed = true;
  }
  if (!Array.isArray(db.teams)) {
    db.teams = [];
    changed = true;
  }
  if (!db.auction || typeof db.auction !== "object") {
    db.auction = structuredClone(defaultDB.auction);
    changed = true;
  }

  db.players.forEach(player => {
    const assignedTeam = player.soldTo || player.team || "";
    if (player.soldTo !== assignedTeam || player.team !== assignedTeam) {
      player.soldTo = assignedTeam;
      player.team = assignedTeam;
      changedPlayerIds.add(player.id);
      changed = true;
    }
  });

  db.teams.forEach(team => {
    const expectedIds = [...new Set(getTeamSquad(team.name).map(player => player.id))];
    const currentIds = Array.isArray(team.players) ? team.players : [];
    const currentCounts = new Map();
    const expectedCounts = new Map();
    currentIds.forEach(id => currentCounts.set(id, (currentCounts.get(id) || 0) + 1));
    expectedIds.forEach(id => expectedCounts.set(id, (expectedCounts.get(id) || 0) + 1));
    const ids = new Set([...currentCounts.keys(), ...expectedCounts.keys()]);
    if (!Array.isArray(team.players) ||
        Array.from(ids).some(id => currentCounts.get(id) !== expectedCounts.get(id)) ||
        currentIds.some((id, index) => id !== expectedIds[index])) {
      ids.forEach(id => changedPlayerIds.add(id));
      team.players = expectedIds;
      changed = true;
    }
  });

  if (changed) {
    const changedPlayers = Array.from(changedPlayerIds).map(id => {
      const player = db.players.find(item => item.id === id);
      return player ? `${player.name || "Unnamed player"} (${id})` : id;
    });
    console.info("Player team cleanup updated:", changedPlayers);
    saveDB(db);
  }
}

function confirmPlayerMove(name, currentTeam, newTeam) {
  const message = `${name} is already in ${currentTeam}. Move to ${newTeam}?`;
  const dialog = document.createElement("dialog");
  dialog.className = "player-move-dialog";
  dialog.innerHTML = `
    <form method="dialog">
      <p>${esc(message)}</p>
      <div class="form-actions">
        <button class="btn btn-cancel" value="cancel">Cancel</button>
        <button class="btn btn-primary" value="move">Move</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  if (typeof dialog.showModal !== "function") {
    dialog.remove();
    return Promise.resolve(window.confirm(message));
  }
  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "move");
      dialog.remove();
    }, { once: true });
    dialog.showModal();
  });
}

// Lightweight toast for non-auction pages
function showToast(msg) {
  let t = document.getElementById("app-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "app-toast";
    t.className = "app-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove("show"), 2800);
}
const fmtDT = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short",
  });
};
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ---------- Tournament & Auction sections ---------- */

function renderDetails(section, dbKey, data) {
  const view = document.getElementById(`${section}-view`);
  if (!view) return;
  view.querySelectorAll(".value").forEach(el => {
    const f = el.dataset.field;
    const v = data[f];
    el.textContent = f === "datetime"
      ? fmtDT(v)
      : (v === "" || v == null ? "—"
        : typeof v === "number" ? v.toLocaleString("en-IN") : v);
  });
}

function bindDetailSection(section, dbKey, fields) {
  const editBtn = document.querySelector(`[data-edit="${section}"]`);
  const form = document.getElementById(`${section}-form`);
  const view = document.getElementById(`${section}-view`);
  if (!editBtn || !form || !view) return;

  editBtn.addEventListener("click", () => {
    // populate form
    fields.forEach(f => {
      const input = form.elements[f];
      if (!input) return;
      input.value = f === "datetime" ? toLocalInput(db[dbKey][f]) : (db[dbKey][f] ?? "");
    });
    view.classList.add("hidden");
    form.classList.remove("hidden");
  });

  form.querySelector(`[data-cancel="${section}"]`).addEventListener("click", () => {
    form.classList.add("hidden");
    view.classList.remove("hidden");
  });

  form.addEventListener("submit", e => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = {};
    const numericFields = ["budget", "purse"];
    fields.forEach(f => {
      if (f === "datetime" && fd.get(f)) {
        data[f] = new Date(fd.get(f)).toISOString();
      } else if (numericFields.includes(f)) {
        data[f] = Number(fd.get(f)) || 0;
      } else {
        data[f] = fd.get(f) || "";
      }
    });
    db[dbKey] = { ...db[dbKey], ...data };
    saveDB(db);
    renderDetails(section, dbKey, data);
    form.classList.add("hidden");
    view.classList.remove("hidden");
  });
}

/* ---------- Generic list sections (teams, players, links) ---------- */

function renderList(key, renderItem, filter) {
  const list = document.getElementById(`${key}-list`);
  if (!list) return;
  list.innerHTML = "";
  const items = filter ? db[key].filter(filter) : db[key];
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">Nothing added yet — click "+ Add" to get started.</div>`;
    return;
  }
  items.forEach(item => list.appendChild(renderItem(item)));
  applyPermissions();
}

/* ---------- Photo helper: resize & compress to JPEG data URL ---------- */
function fileToDataURL(file, maxSize = 500, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function bindListSection(key, fields, renderItem, filter) {
  const addBtn = document.getElementById(`add-${key}`);
  const form = document.getElementById(`${key}-form`);
  const listEl = document.getElementById(`${key}-list`);
  if (!addBtn || !form || !listEl) return;
  let editingId = null;

  addBtn.addEventListener("click", () => {
    editingId = null;
    form.reset();
    form.querySelectorAll("select").forEach(s => s.dispatchEvent(new Event("change")));
    listEl.classList.add("hidden");
    form.classList.remove("hidden");
    if (key === "players") refreshPlayerRoleSelects(null);
  });

  // Floating action button — mirrors Add (no-op when hidden by permissions)
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab";
  fab.textContent = "+";
  fab.setAttribute("aria-label", "Add new");
  fab.addEventListener("click", () => { if (addBtn.offsetParent !== null) addBtn.click(); });
  document.body.appendChild(fab);

  // Role picker buttons → hidden select (players form)
  const rolePicker = form.querySelector(".role-picker");
  const roleSelect = form.querySelector('select[name="role"]');
  function syncRoleBtns() {
    if (!rolePicker || !roleSelect) return;
    rolePicker.querySelectorAll(".role-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.role === roleSelect.value);
    });
  }
  if (rolePicker && roleSelect) {
    rolePicker.querySelectorAll(".role-btn").forEach(b => {
      b.addEventListener("click", () => {
        roleSelect.value = b.dataset.role;
        syncRoleBtns();
      });
    });
    roleSelect.addEventListener("change", syncRoleBtns);
    syncRoleBtns();
  }

  form.querySelector(`[data-cancel="${key}"]`).addEventListener("click", () => {
    form.classList.add("hidden");
    listEl.classList.remove("hidden");
    editingId = null;
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = {};
    fields.forEach(f => {
      data[f] = ["basePrice", "budget", "purse"].includes(f)
        ? Number(fd.get(f)) || 0
        : (fd.get(f) || "");
    });

    // Player photo upload (players only)
    if (key === "players") {
      const fileInput = form.elements.photo;
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        data.photo = await fileToDataURL(file);
      } else if (editingId) {
        const existing = db.players.find(p => p.id === editingId);
        if (existing && existing.photo) data.photo = existing.photo;
      }
    }

    // Team logo + captain photo uploads (teams only)
    if (key === "teams") {
      const logoFile = form.elements.logo && form.elements.logo.files[0];
      const capFile = form.elements.ownerPhoto && form.elements.ownerPhoto.files[0];
      const iconFile = form.elements.iconPlayerPhoto && form.elements.iconPlayerPhoto.files[0];
      const existing = editingId ? db.teams.find(t => t.id === editingId) : null;
      if (logoFile) data.logo = await fileToDataURL(logoFile);
      else if (existing && existing.logo) data.logo = existing.logo;
      if (capFile) data.ownerPhoto = await fileToDataURL(capFile);
      else if (existing && existing.ownerPhoto) data.ownerPhoto = existing.ownerPhoto;
      if (iconFile) data.iconPlayerPhoto = await fileToDataURL(iconFile);
      else if (existing && existing.iconPlayerPhoto) data.iconPlayerPhoto = existing.iconPlayerPhoto;
    }

    if (key === "notes") {
      data.owner = session.email || session.name;
      data.updatedAt = Date.now();
    }

    // Icon / Captain uniqueness: one per team
    if (key === "players") {
      const existingPlayer = editingId
        ? db.players.find(player => player.id === editingId)
        : null;
      const currentTeam = existingPlayer
        ? (existingPlayer.soldTo || existingPlayer.team || "")
        : "";
      const newTeam = data.team || "";
      if (existingPlayer && currentTeam !== newTeam &&
          (existingPlayer.captainFor || existingPlayer.iconFor)) {
        showToast("Change the captain/icon on the Teams page first.");
        return;
      }

      // Associated Team is mandatory when any special role is assigned
      if ((data.iconFor || data.captainFor) && !data.team) {
        showToast("Associated Team is required when Icon / Captain is set");
        return;
      }
      if ((data.iconFor && data.iconFor !== data.team) ||
          (data.captainFor && data.captainFor !== data.team)) {
        showToast("A player must belong to the same team they represent as captain or icon.");
        return;
      }
      const iconTeam = data.iconFor || "", capTeam = data.captainFor || "";
      if (iconTeam) {
        const ex = db.players.find(p => p.id !== editingId && p.iconFor === iconTeam);
        if (ex) { showToast(`${iconTeam} already has an icon player (${ex.name})`); return; }
      }
      if (capTeam) {
        const ex = db.players.find(p => p.id !== editingId && p.captainFor === capTeam);
        if (ex) { showToast(`${capTeam} already has a captain/owner (${ex.name})`); return; }
      }
      if (existingPlayer && currentTeam && newTeam && currentTeam !== newTeam &&
          !await confirmPlayerMove(data.name || existingPlayer.name, currentTeam, newTeam)) {
        return;
      }
    }

    let savedItem = null;
    if (editingId) {
      const idx = db[key].findIndex(i => i.id === editingId);
      if (idx > -1) {
        db[key][idx] = { ...db[key][idx], ...data };
        savedItem = db[key][idx];
      }
    } else {
      savedItem = { id: uid(), ...data };
      db[key].push(savedItem);
    }

    // Keep the assignment mirrors and team rosters in sync.
    if (key === "players" && savedItem) {
      assignPlayerToTeam(savedItem.id, data.team || "— None —");
    }
    saveDB(db);
    renderList(key, renderItem, filter);
    form.classList.add("hidden");
    listEl.classList.remove("hidden");
    editingId = null;
  });

  // Edit/delete via event delegation
  listEl.addEventListener("click", e => {
    const control = e.target.closest("button, a, select, input");
    if (!control && key === "teams") {
      const card = e.target.closest(".item.has-squad");
      const squad = card && card.querySelector(".team-squad");
      if (card && squad && listEl.contains(card)) {
        const isOpen = squad.classList.contains("hidden");
        squad.classList.toggle("hidden", !isOpen);
        card.classList.toggle("expanded", isOpen);
        const hint = card.querySelector(".squad-hint");
        if (hint) hint.textContent = isOpen ? "▲ squad" : "▼ squad";
        return;
      }
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const item = db[key].find(i => i.id === id);
    if (!item) return;

    if (action === "delete") {
      if (confirm(`Delete "${item.name || item.title}"?`)) {
        db[key] = db[key].filter(i => i.id !== id);
        saveDB(db);
        renderList(key, renderItem, filter);
      }
    } else if (action === "edit") {
      editingId = id;
      fields.forEach(f => {
        const input = form.elements[f];
        if (input) input.value = item[f] ?? "";
      });
      form.querySelectorAll("select").forEach(s => s.dispatchEvent(new Event("change")));
      listEl.classList.add("hidden");
      form.classList.remove("hidden");
      if (key === "players") refreshPlayerRoleSelects(id);
      // Show existing photo preview when editing a player
      if (key === "players") {
        const preview = document.getElementById("photo-preview");
        if (preview) {
          if (item.photo) { preview.src = item.photo; preview.classList.remove("hidden"); }
          else { preview.removeAttribute("src"); preview.classList.add("hidden"); }
        }
      }
      // Show existing logo/captain previews when editing a team
      if (key === "teams") {
        [["logo-preview", item.logo], ["owner-photo-preview", item.ownerPhoto], ["icon-player-photo-preview", item.iconPlayerPhoto]].forEach(([id, src]) => {
          const el = document.getElementById(id);
          if (el) {
            if (src) { el.src = src; el.classList.remove("hidden"); }
            else { el.removeAttribute("src"); el.classList.add("hidden"); }
          }
        });
      }
      form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

/* ---------- Renderers ---------- */

function teamItem(t) {
  const el = document.createElement("div");
  el.className = "item has-squad";
  el.setAttribute("data-team-id", t.id);

  const subs = [];
  if (t.owner) subs.push(`Owner / Captain: ${esc(t.owner)}`);
  if (t.email && session.role === "admin") subs.push(`✉️ ${esc(t.email)}`);
  if (t.tournament) subs.push(`🏆 ${esc(t.tournament)}`);
  if (t.auction) subs.push(`🔨 ${esc(t.auction)}`);
  if (t.budget) subs.push(`Budget ₹${Number(t.budget).toLocaleString("en-IN")}`);
  if (t.purse) subs.push(`Purse ₹${Number(t.purse).toLocaleString("en-IN")}`);
  if (t.status) subs.push(esc(t.status));
  if (t.iconPlayer) subs.push(`Icon: ${esc(t.iconPlayer)}`);

  const squadPlayers = getTeamSquad(t.name);
  const squadRank = p => p.captainFor === t.name ? 0 : p.iconFor === t.name ? 1 : 2;
  squadPlayers.sort((a, b) => {
    const ra = squadRank(a), rb = squadRank(b);
    return ra - rb;
  });

  if (squadPlayers.length) subs.push(`Squad: ${squadPlayers.length}`);

  const squadHtml = squadPlayers.length
    ? squadPlayers.map((p, index) => {
        const tags = [
          p.captainFor && `<span class="role-tag role-captain" title="Captain: ${esc(p.captainFor)}">C</span>`,
          p.iconFor && `<span class="role-tag role-icon" title="Icon: ${esc(p.iconFor)}">I</span>`,
        ].filter(Boolean).join("");
        const priceVal = p.soldPrice || 0;
        return `
        <div class="squad-row">
          <span class="squad-number">${index + 1}.</span>
          ${p.photo
            ? `<img class="player-thumb" src="${p.photo}" alt="${esc(p.name)}" />`
            : `<div class="player-thumb player-thumb-empty">🏏</div>`}
          <span class="squad-name">${esc(p.name)}${tags}</span>
          <span class="badge">${esc(p.role || "Player")}</span>
          <span class="squad-price">₹${Number(priceVal).toLocaleString("en-IN")}</span>
        </div>`;
      }).join("")
    : `<div class="squad-empty">No players in this squad yet.</div>`;

  el.innerHTML = `
    <div class="item-main">
      <div class="item-title">${t.logo ? `<img class="team-logo-sm" src="${t.logo}" alt="${esc(t.name)} logo" />` : ""}<span class="team-name-toggle">${esc(t.name)}</span> <span class="squad-hint">▼ squad</span></div>
      ${subs.length ? `<div class="item-sub">${subs.join(" · ")}</div>` : ""}
    </div>
    <div class="item-actions">
      <button class="btn btn-edit" data-action="edit" data-id="${t.id}">Edit</button>
      <button class="btn btn-danger" data-action="delete" data-id="${t.id}">Delete</button>
    </div>
    <div class="team-squad hidden">${squadHtml}</div>`;
  return el;
}

function playerItem(p) {
  const el = document.createElement("div");
  el.className = "item";
  const thumb = p.photo
    ? `<img class="player-thumb" src="${p.photo}" alt="${esc(p.name)}" />`
    : `<div class="player-thumb player-thumb-empty">🏏</div>`;
  const subs = [`Base price: ₹${(p.basePrice || 0).toLocaleString("en-IN")}`];
  if (p.soldTo) subs.push(`Team: ${esc(p.soldTo)}`);
  if (p.iconFor) subs.push(`Icon: ${esc(p.iconFor)}`);
  if (p.captainFor) subs.push(`Captain: ${esc(p.captainFor)}`);
  if (p.soldTo && p.soldPrice) subs.push(`Sold @ ₹${Number(p.soldPrice).toLocaleString("en-IN")}`);
  const roleTags = [
    p.captainFor && `<span class="role-tag role-captain" title="Captain: ${esc(p.captainFor)}">C</span>`,
    p.iconFor && `<span class="role-tag role-icon" title="Icon: ${esc(p.iconFor)}">I</span>`,
  ].filter(Boolean).join("");
  el.innerHTML = `
    ${thumb}
    <div class="item-main">
      <div class="item-title">${esc(p.name)} <span class="badge">${esc(p.role)}</span>${roleTags}</div>
      <div class="item-sub">${subs.join(" · ")}</div>
    </div>
    <div class="item-actions">
      <button class="btn btn-edit" data-action="edit" data-id="${p.id}">Edit</button>
      <button class="btn btn-danger" data-action="delete" data-id="${p.id}">Delete</button>
    </div>`;
  return el;
}

function noteItem(n) {
  const el = document.createElement("div");
  el.className = "item note-item";
  const when = n.updatedAt ? new Date(n.updatedAt).toLocaleString() : "";
  el.innerHTML = `
    <div class="item-main">
      <div class="item-title note-text"></div>
      <div class="item-sub">Updated ${esc(when)}</div>
    </div>
    <div class="item-actions">
      <button class="btn btn-edit" data-action="edit" data-id="${n.id}">Edit</button>
      <button class="btn btn-danger" data-action="delete" data-id="${n.id}">Delete</button>
    </div>`;
  el.querySelector(".note-text").textContent = n.text || "";
  return el;
}

function linkItem(l) {
  const el = document.createElement("div");
  el.className = "item link-item";
  el.innerHTML = `
    <div class="item-main">
      <div class="item-title">${esc(l.title)}</div>
      <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.url)}</a>
    </div>
    <div class="item-actions">
      <button class="btn btn-edit" data-action="edit" data-id="${l.id}">Edit</button>
      <button class="btn btn-danger" data-action="delete" data-id="${l.id}">Delete</button>
    </div>`;
  return el;
}

/* ---------- Permission gating ---------- */
function applyPermissions() {
  const allowed = ROLE_PERMS[session?.role] || [];

  // Detail sections: hide Edit buttons
  document.querySelectorAll("[data-edit]").forEach(btn => {
    if (!allowed.includes(btn.dataset.edit)) btn.style.display = "none";
  });

  // List sections: hide Add buttons and per-item Edit/Delete buttons
  ["teams", "players", "links", "notes"].forEach(key => {
    const addBtn = document.getElementById(`add-${key}`);
    if (addBtn && !allowed.includes(key)) addBtn.style.display = "none";
    if (!allowed.includes(key)) {
      document.querySelectorAll(`#${key}-list .item-actions`)
        .forEach(el => { el.style.display = "none"; });
    }
  });
}

/* ---------- User chip + logout in nav ---------- */
(function injectUserChip() {
  const header = document.querySelector(".header-inner");
  if (!header || !session) return;

  const userWrap = document.createElement("div");
  userWrap.className = "header-user";

  const chip = document.createElement("span");
  chip.className = "user-chip";
  chip.textContent = session.name;
  chip.title = `Logged in as ${session.role}`;
  userWrap.appendChild(chip);

  const logout = document.createElement("a");
  logout.href = "#";
  logout.className = "logout-link";
  logout.textContent = "Logout";
  logout.addEventListener("click", e => {
    e.preventDefault();
    localStorage.removeItem(SESSION_KEY);
    location.href = "login.html";
  });
  userWrap.appendChild(logout);
  header.appendChild(userWrap);
})();

/* ---------- Dynamic dropdown helpers ---------- */
// Fill a <select> with options; keeps current selection if still valid.
function fillSelect(el, options) {
  if (!el) return;
  const current = el.value;
  el.innerHTML = `<option value="">— None —</option>` +
    options.filter(Boolean).map(o =>
      `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  if (current && options.includes(current)) el.value = current;
}

// Captain/Icon dropdowns: hide teams that already have that role;
// hide the whole field once every team is filled for that role.
function refreshPlayerRoleSelects(excludeId) {
  const form = document.getElementById("players-form");
  if (!form) return;
  const teamNames = db.teams.map(t => t.name);
  [["captainFor", "f-captain"], ["iconFor", "f-icon"]]
    .forEach(([field, labelId]) => {
      const sel = form.elements[field];
      const label = document.getElementById(labelId);
      if (!sel) return;
      const taken = new Set(db.players
        .filter(p => p.id !== excludeId && p[field])
        .map(p => p[field]));
      const available = teamNames.filter(n => !taken.has(n));
      const current = sel.value;
      sel.innerHTML = `<option value="">— None —</option>` +
        available.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      sel.value = (current && available.includes(current)) ? current : "";
      if (label) label.classList.toggle("hidden", available.length === 0);
    });
}

const q = sel => document.querySelector(sel);

/* ---------- Auction live controls (admin) ---------- */
const startAuctionBtn = document.getElementById("start-auction");
const endAuctionBtn = document.getElementById("end-auction");
const liveBadge = document.getElementById("live-badge");
const resetAuctionBtn = document.getElementById("reset-auction");

// ---- Auction stage (full-screen random player draw) ----
const overlay = document.getElementById("auction-overlay");
const aoPhoto = document.getElementById("ao-photo");
const aoName = document.getElementById("ao-name");
const aoDetails = document.getElementById("ao-details");
const aoCounter = document.getElementById("ao-counter");
const aoSoldBtn = document.getElementById("ao-sold");
const aoUnsoldBtn = document.getElementById("ao-unsold");
const aoSkipBtn = document.getElementById("ao-skip");
const aoUndoSaleBtn = document.getElementById("ao-undo-sale");
const aoCloseBtn = document.getElementById("ao-close");
const aoTeamPicker = document.getElementById("ao-team-picker");
const aoTeamSelect = document.getElementById("ao-team-select");
const aoConfirmBtn = document.getElementById("ao-confirm-sold");
const aoPriceInput = document.getElementById("ao-price");
const aoPriceError = document.getElementById("ao-price-error");
const aoSquadTeam = document.getElementById("ao-squad-team");
const aoSquadBody = document.getElementById("ao-squad-body");
const aoSquadPurse = document.getElementById("ao-squad-purse");
const aoSquadCount = document.getElementById("ao-squad-count");
const confettiLayer = document.getElementById("ao-confetti");
let stageQueue = [];
let stageCurrent = null;
let celebrating = false;
let squadTeamName = null;
let lastSoldRowId = null;

/* ---------- Team squad panel (admin stage + live viewer) ---------- */
function inr(n) { return "₹" + (Number(n) || 0).toLocaleString("en-IN"); }

function teamSoldSum(data, t) {
  return getTeamSquad(t.name, data)
    .reduce((sum, player) => sum + (player.soldPrice || 0), 0);
}
function remainingPurse(data, t) {
  return Math.max(0, (t.purse || t.budget || 0) - teamSoldSum(data, t));
}

function renderSquadPanel(data) {
  if (!aoSquadBody || !data) return;
  const teams = data.teams || [];
  if (aoSquadTeam) {
    const cur = squadTeamName || aoSquadTeam.value;
    aoSquadTeam.innerHTML = teams.map(t =>
      `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    if (cur && teams.some(t => t.name === cur)) aoSquadTeam.value = cur;
    else if (teams.length) aoSquadTeam.value = teams[0].name;
    squadTeamName = aoSquadTeam.value || null;
  }
  const team = teams.find(t => t.name === squadTeamName);
  if (!team) {
    aoSquadBody.innerHTML = "";
    if (aoSquadPurse) aoSquadPurse.textContent = "";
    if (aoSquadCount) aoSquadCount.textContent = "";
    return;
  }
  const rows = getTeamSquad(team.name, data)
    .sort((a, b) => {
      const rank = player => player.captainFor === team.name ? 0
        : player.iconFor === team.name ? 1 : 2;
      return rank(a) - rank(b);
    })
    .map(player => {
      const type = player.captainFor === team.name ? "Captain"
        : player.iconFor === team.name ? "Icon" : "Player";
      return {
        name: player.name,
        type,
        price: type === "Player" ? inr(player.soldPrice || 0) : "Nil",
        pid: player.id,
      };
    });
  aoSquadBody.innerHTML = rows.length
    ? rows.map((r, i) =>
        `<tr class="${r.pid && r.pid === lastSoldRowId ? "row-new" : ""}">
          <td>${i + 1}</td><td>${esc(r.name)}</td><td class="squad-type">${r.type}</td><td>${r.price}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="squad-empty">No squad yet</td></tr>`;
  if (aoSquadPurse) aoSquadPurse.textContent = `Remaining Purse: ${inr(remainingPurse(data, team))}`;
  if (aoSquadCount) aoSquadCount.textContent = `Players: ${rows.length}`;
}

function donePlayerIds() {
  return [...(db.auction.soldPlayers || []), ...(db.auction.unsoldPlayers || [])];
}

function pendingPlayers() {
  const done = donePlayerIds();
  return db.players.filter(p => !done.includes(p.id) && !p.soldTo && !p.iconFor && !p.captainFor);
}

function resetAuctionAssignments() {
  const recordedSales = new Set(db.auction.soldPlayers || []);
  const boughtIds = new Set((db.players || [])
    .filter(player => player.auctionBought ||
      (recordedSales.has(player.id) && Number(player.soldPrice) > 0))
    .map(player => player.id));
  boughtIds.forEach(id => {
    const player = db.players.find(item => item.id === id);
    if (player && !player.captainFor && !player.iconFor) {
      assignPlayerToTeam(id, "— None —");
    }
  });
  db.auction.soldPlayers = [];
  db.auction.unsoldPlayers = [];
  db.auction.stagePlayerId = null;
  db.auction.lastSale = null;
  db.auction.lastEvent = { type: "reset", ts: Date.now() };
}

function updateUndoSaleButton() {
  if (!aoUndoSaleBtn) return;
  const sale = db.auction.lastSale;
  aoUndoSaleBtn.classList.toggle("hidden", !sale || sale.undone || session.role !== "admin");
  aoUndoSaleBtn.disabled = celebrating;
}

function showConfetti() {
  if (!confettiLayer) return;
  confettiLayer.innerHTML = "";
  confettiLayer.classList.remove("hidden");
  const colors = ["#d90429", "#16a34a", "#f59e0b", "#3b82f6", "#a855f7", "#facc15", "#ec4899"];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.4) + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    confettiLayer.appendChild(p);
  }
  setTimeout(() => confettiLayer.classList.add("hidden"), 1500);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showStagePlayer(p) {
  stageCurrent = p;
  aoSoldBtn.classList.remove("hidden");
  aoUnsoldBtn?.classList.remove("hidden");
  aoSkipBtn?.classList.remove("hidden");
  aoTeamPicker?.classList.add("hidden");
  updateUndoSaleButton();
  if (p.photo) { aoPhoto.src = p.photo; aoPhoto.classList.remove("hidden"); }
  else { aoPhoto.removeAttribute("src"); aoPhoto.classList.add("hidden"); }
  aoName.textContent = p.name || "—";
  const sold = (db.auction.soldPlayers || []).length;
  const unsold = (db.auction.unsoldPlayers || []).length;
  aoCounter.textContent = `${sold} sold · ${pendingPlayers().length} left · ${unsold} unsold`;
  aoDetails.innerHTML = `
    <span class="badge">${esc(p.role || "Player")}</span>
    <span class="stage-price">Base: ₹${(p.basePrice || 0).toLocaleString("en-IN")}</span>
    ${p.soldTo ? `<div class="stage-team">${esc(p.soldTo)}</div>` : ""}`;

  // Publish current player for mirrored viewers
  db.auction.stagePlayerId = p.id;
  saveDB(db);
}

function showUnsoldSummary() {
  const unsoldList = db.players.filter(p =>
    (db.auction.unsoldPlayers || []).includes(p.id));
  aoPhoto.classList.add("hidden");
  aoCounter.textContent = "";
  aoSoldBtn.classList.add("hidden");
  aoUnsoldBtn?.classList.add("hidden");
  aoSkipBtn?.classList.add("hidden");
  updateUndoSaleButton();
  if (unsoldList.length) {
    aoName.textContent = "Unsold Players";
    aoDetails.innerHTML = unsoldList.map(p =>
      `<div class="unsold-row"><span>${esc(p.name)}</span><span class="badge">${esc(p.role || "Player")}</span></div>`
    ).join("");
  } else {
    aoName.textContent = "All players sold! 🎉";
    aoDetails.innerHTML = "<div class='stage-team'>No unsold players.</div>";
  }
  db.auction.stagePlayerId = null;
  db.auction.lastEvent = { type: "done", ts: Date.now() };
  saveDB(db);
}

function showNextStagePlayer() {
  if (!stageQueue.length) {
    // Recursion: unsold players go back into the draw for another round,
    // one after another, until a full pass sells everyone or admin ends it.
    const unsoldIds = db.auction.unsoldPlayers || [];
    if (unsoldIds.length) {
      const again = db.players.filter(p => unsoldIds.includes(p.id));
      db.auction.unsoldPlayers = [];
      stageQueue = shuffle(again);
      db.auction.lastEvent = { type: "reauction", ts: Date.now(), count: again.length };
      saveDB(db);
      renderSquadPanel(db);
      stageToast(`🔁 ${again.length} unsold player(s) back in the draw`, "skip");
      showStagePlayer(stageQueue.shift());
      return;
    }
    // 4-second transition screen before the unsold summary
    aoPhoto.classList.add("hidden");
    aoCounter.textContent = "";
    aoSoldBtn.classList.add("hidden");
    aoUnsoldBtn?.classList.add("hidden");
    aoSkipBtn?.classList.add("hidden");
    updateUndoSaleButton();
    aoName.textContent = "Unsold Players appearing…";
    aoDetails.innerHTML = "<div class='stage-team'>Get ready 👀</div>";
    db.auction.stagePlayerId = null;
    db.auction.lastEvent = { type: "unsold-soon", ts: Date.now() };
    saveDB(db);
    setTimeout(() => {
      if (!stageQueue.length && overlay && !overlay.classList.contains("hidden")) {
        showUnsoldSummary();
      }
    }, 4000);
    return;
  }
  showStagePlayer(stageQueue.shift());
}

function undoLastAuctionSale() {
  const sale = db.auction.lastSale;
  if (!sale || sale.undone || celebrating) return;
  const player = db.players.find(item => item.id === sale.pid);
  if (!player) {
    showToast("The player from the last sale could not be found.");
    return;
  }
  if (!confirm(`Undo ${player.name}'s sale to ${sale.team}?`)) return;

  const currentPlayer = stageCurrent;
  const currentIsPending = currentPlayer && currentPlayer.id !== player.id &&
    pendingPlayers().some(item => item.id === currentPlayer.id);
  assignPlayerToTeam(player.id, "— None —");
  sale.undone = true;
  db.auction.lastEvent = {
    type: "undo-sold", team: sale.team, player: player.name, pid: player.id, ts: Date.now(),
  };
  stageQueue = stageQueue.filter(item => item.id !== player.id);
  if (currentIsPending && !stageQueue.some(item => item.id === currentPlayer.id)) {
    stageQueue.unshift(currentPlayer);
  }
  stageQueue.unshift(player);
  squadTeamName = sale.team;
  updateUndoSaleButton();
  renderSquadPanel(db);
  stageToast(`Sale undone — ${player.name} returned to the auction`, "skip");
  showNextStagePlayer();
}

function openAuctionStage() {
  if (!overlay) return;
  if (!overlay.classList.contains("hidden")) return; // already open — don't rebuild queue
  stageQueue = shuffle(pendingPlayers());
  aoSoldBtn.classList.remove("hidden");
  aoUnsoldBtn?.classList.remove("hidden");
  aoSkipBtn?.classList.remove("hidden");
  if (aoTeamPicker) aoTeamPicker.classList.add("hidden");
  overlay.classList.remove("hidden");
  renderSquadPanel(db);
  showNextStagePlayer();
}

function closeAuctionStage() {
  if (overlay) overlay.classList.add("hidden");
}

// Admin stage toast (viewport-fixed, same look as viewer)
const aoMsgEl = document.getElementById("ao-message");
let stageMsgTimer = null;
function stageToast(text, type) {
  if (!aoMsgEl) return;
  aoMsgEl.textContent = text;
  aoMsgEl.className = "ao-message show " + type;
  clearTimeout(stageMsgTimer);
  stageMsgTimer = setTimeout(() => aoMsgEl.classList.remove("show"), 2600);
}

if (overlay) {
  // SOLD → pick team → confirm → confetti → next player
  aoSoldBtn?.addEventListener("click", () => {
    if (!stageCurrent || celebrating) return;
    if (aoTeamSelect) {
      aoTeamSelect.innerHTML = `<option value="">— Select team —</option>` +
        db.teams.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    }
    if (aoPriceInput) aoPriceInput.value = stageCurrent.basePrice || 0;
    aoTeamPicker?.classList.remove("hidden");
    aoSoldBtn.classList.add("hidden");
    aoUnsoldBtn?.classList.add("hidden");
    aoSkipBtn?.classList.add("hidden");
  });

  aoConfirmBtn?.addEventListener("click", () => {
    const teamName = aoTeamSelect?.value;
    if (!teamName || !stageCurrent || celebrating) return;
    const soldPrice = Math.max(0, Number(aoPriceInput?.value) || stageCurrent.basePrice || 0);

    // Validate: price cannot exceed team's remaining purse
    const team = db.teams.find(t => t.name === teamName);
    if (team && soldPrice > remainingPurse(db, team)) {
      if (aoPriceError) {
        aoPriceError.textContent = `Price exceeds remaining purse (${inr(remainingPurse(db, team))})`;
        aoPriceError.classList.remove("hidden");
      }
      return;
    }
    if (aoPriceError) aoPriceError.classList.add("hidden");
    celebrating = true;

    // Mark sold + record team + price
    db.auction.soldPlayers = db.auction.soldPlayers || [];
    if (!db.auction.soldPlayers.includes(stageCurrent.id)) {
      db.auction.soldPlayers.push(stageCurrent.id);
    }
    const player = assignPlayerToTeam(stageCurrent.id, teamName);
    if (player) {
      player.soldPrice = soldPrice;
      player.auctionBought = true;
    }
    db.auction.lastSale = {
      pid: stageCurrent.id, player: stageCurrent.name, team: teamName,
      price: soldPrice, ts: Date.now(), undone: false,
    };
    updateUndoSaleButton();
    squadTeamName = teamName;
    lastSoldRowId = stageCurrent.id;
    db.auction.lastEvent = { type: "sold", team: teamName, player: stageCurrent.name, price: soldPrice, pid: stageCurrent.id, ts: Date.now() };
    saveDB(db);
    renderSquadPanel(db);
    stageToast(`SOLD → ${teamName} @ ${inr(soldPrice)} (${stageCurrent.name})`, "sold");

    // Celebration, then auto-advance
    showConfetti();
    aoTeamPicker?.classList.add("hidden");
    setTimeout(() => {
      celebrating = false;
      updateUndoSaleButton();
      showNextStagePlayer();
    }, 1400);
  });

  aoUndoSaleBtn?.addEventListener("click", undoLastAuctionSale);

  // UNSOLD → mark unsold → next player
  aoUnsoldBtn?.addEventListener("click", () => {
    if (!stageCurrent || celebrating) return;
    assignPlayerToTeam(stageCurrent.id, "— None —");
    db.auction.unsoldPlayers = db.auction.unsoldPlayers || [];
    if (!db.auction.unsoldPlayers.includes(stageCurrent.id)) {
      db.auction.unsoldPlayers.push(stageCurrent.id);
    }
    db.auction.lastEvent = { type: "unsold", player: stageCurrent.name, ts: Date.now() };
    saveDB(db);
    renderSquadPanel(db);
    stageToast(`${stageCurrent.name} — UNSOLD`, "unsold");
    showNextStagePlayer();
  });

  aoSquadTeam?.addEventListener("change", () => {
    squadTeamName = aoSquadTeam.value;
    renderSquadPanel(db);
  });
  aoTeamSelect?.addEventListener("change", () => {
    if (aoTeamSelect.value) {
      squadTeamName = aoTeamSelect.value;
      renderSquadPanel(db);
    }
  });

  aoCloseBtn?.addEventListener("click", () => {
    closeAuctionStage();
    // Also end the auction entirely
    db.auction.live = false;
    saveDB(db);
    refreshAuctionLiveUI();
  });
}

/* ---------- Viewer mirror stage (live.html — read-only) ---------- */
function initViewerStage() {
  // Only runs on live.html — #ao-exit exists solely in the viewer overlay.
  // (#ao-message also exists on auction.html for admin toasts, so it can't be the guard.)
  if (!document.getElementById("ao-exit")) return;
  const msgEl = document.getElementById("ao-message");
  const vOverlay = document.getElementById("auction-overlay");
  const vPhoto = document.getElementById("ao-photo");
  const vName = document.getElementById("ao-name");
  const vDetails = document.getElementById("ao-details");
  const vCounter = document.getElementById("ao-counter");
  const vMyTeam = document.getElementById("ao-myteam");
  const vExit = document.getElementById("ao-exit");
  const vRejoin = document.getElementById("ao-rejoin");
  const vEnter = document.getElementById("enter-auction");
  let lastPlayerId = null, lastEventTs = 0, msgTimer = null, firstTick = true;
  let viewerExited = false;
  let viewerJoined = false;

  vEnter?.addEventListener("click", () => {
    viewerJoined = true;
    viewerExited = false;
    tick();
  });
  vExit?.addEventListener("click", () => {
    viewerExited = true;
    vOverlay.classList.add("hidden");
    vRejoin?.classList.remove("hidden");
  });
  vRejoin?.addEventListener("click", () => {
    viewerExited = false;
    vRejoin.classList.add("hidden");
    tick();
  });

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className = "ao-message show " + type;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => msgEl.classList.remove("show"), 2600);
  }
  document.getElementById("ao-squad-team")?.addEventListener("change", e => {
    squadTeamName = e.target.value;
    if (remoteSnapshot) renderSquadPanel(remoteSnapshot);
  });

  function tick() {
    let remote = remoteSnapshot;
    if (!remote) {
      try { remote = JSON.parse(localStorage.getItem(DB_KEY)); } catch { return; }
    }
    if (!remote || !remote.auction || !remote.auction.live) {
      vOverlay.classList.add("hidden");
      vExit?.classList.add("hidden");
      vEnter?.classList.add("hidden");
      vRejoin?.classList.add("hidden");
      viewerJoined = false;
      return;
    }
    const inStage = viewerJoined && !viewerExited;
    vOverlay.classList.toggle("hidden", !inStage);
    vExit?.classList.toggle("hidden", !inStage);
    vEnter?.classList.toggle("hidden", inStage);
    if (viewerExited) vRejoin?.classList.remove("hidden");
    else vRejoin?.classList.add("hidden");

    const ln = document.getElementById("live-auction-name");
    if (ln && remote.auction && remote.auction.name) ln.textContent = remote.auction.name;
    if (!inStage) return;

    const ev = remote.auction.lastEvent;
    if (firstTick) {
      // Don't replay the previous event on load/refresh — just record its timestamp
      lastEventTs = ev && ev.ts ? ev.ts : 0;
      firstTick = false;
    }
    if (ev && ev.ts > lastEventTs) {
      lastEventTs = ev.ts;
      if (ev.type === "sold") {
        showMsg(`SOLD → ${ev.team || "team"} @ ₹${(ev.price || 0).toLocaleString("en-IN")} (${ev.player || ""})`, "sold");
        showConfetti();
        if (ev.team) squadTeamName = ev.team;
        if (ev.pid) lastSoldRowId = ev.pid;
      } else if (ev.type === "unsold") {
        showMsg(`${ev.player || "Player"} — UNSOLD`, "unsold");
      } else if (ev.type === "unsold-soon") {
        showMsg("Unsold players appearing…", "unsold");
      } else if (ev.type === "reauction") {
        showMsg(`🔁 ${ev.count || ""} unsold player(s) back in the draw`, "skip");
      } else if (ev.type === "undo-sold") {
        showMsg(`${ev.player || "Player"} returned to the auction`, "skip");
      } else if (ev.type === "done") {
        showMsg("Auction finished", "done");
      }
    }

    // Owner HUD: purse remaining + players bought (top-right)
    if (vMyTeam) {
      const myTeam = (remote.teams || []).find(t =>
        (t.email || "").trim().toLowerCase() === (session.email || "").toLowerCase());
      if (session.role === "owner" && myTeam) {
        const purse = myTeam.purse || myTeam.budget || 0;
        const left = Math.max(0, purse - teamSoldSum(remote, myTeam));
        const count = getTeamSquad(myTeam.name, remote).length;
        vMyTeam.textContent = `💰 ₹${left.toLocaleString("en-IN")} left · ${count} player${count === 1 ? "" : "s"}`;
        vMyTeam.classList.remove("hidden");
      } else {
        vMyTeam.classList.add("hidden");
      }
    }

    renderSquadPanel(remote);

    const pid = remote.auction.stagePlayerId;
    if (pid !== lastPlayerId) {
      lastPlayerId = pid;
      const p = remote.players.find(x => x.id === pid);
      if (p) {
        if (p.photo) { vPhoto.src = p.photo; vPhoto.classList.remove("hidden"); }
        else { vPhoto.removeAttribute("src"); vPhoto.classList.add("hidden"); }
        vName.textContent = p.name || "—";
        const sold = (remote.auction.soldPlayers || []).length;
        const unsold = (remote.auction.unsoldPlayers || []).length;
        const left = remote.players.filter(x =>
          !(remote.auction.soldPlayers || []).includes(x.id) &&
          !(remote.auction.unsoldPlayers || []).includes(x.id) &&
          !x.soldTo && !x.iconFor && !x.captainFor).length;
        vCounter.textContent = `${sold} sold · ${left} left · ${unsold} unsold`;
        vDetails.innerHTML = `
          <span class="badge">${esc(p.role || "Player")}</span>
          <span class="stage-price">Base: ₹${(p.basePrice || 0).toLocaleString("en-IN")}</span>
          ${p.soldTo ? `<div class="stage-team">${esc(p.soldTo)}</div>` : ""}`;
      } else {
        vName.textContent = "Waiting for players…";
        vDetails.innerHTML = "";
        vPhoto.classList.add("hidden");
        vCounter.textContent = "";
      }
    }
  }

  if (sbClient) {
    sbClient
      .channel("app_state_live")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "app_state" },
        payload => { remoteSnapshot = payload.new?.data; tick(); })
      .subscribe();
  } else {
    setInterval(tick, 800);
    window.addEventListener("storage", tick);
  }
  tick();
}

function refreshAuctionLiveUI() {
  const live = !!db.auction.live;
  const isAdmin = session.role === "admin";

  if (liveBadge) liveBadge.classList.toggle("hidden", !live);
  if (startAuctionBtn) startAuctionBtn.classList.toggle("hidden", live || !isAdmin);
  if (endAuctionBtn) endAuctionBtn.classList.toggle("hidden", !live || !isAdmin);
  if (resetAuctionBtn) resetAuctionBtn.classList.toggle("hidden", live || !isAdmin);

  const heroChip = document.getElementById("hero-live-chip");
  if (heroChip) heroChip.classList.toggle("hidden", !live);

  // "View Auction" buttons show for all roles while live
  document.querySelectorAll(".view-auction-btn").forEach(btn => {
    btn.classList.toggle("hidden", !live);
  });

}

startAuctionBtn?.addEventListener("click", () => {
  resetAuctionAssignments();
  db.auction.live = true;
  db.auction.liveAt = Date.now();
  stageQueue = [];
  stageCurrent = null;
  celebrating = false;
  updateUndoSaleButton();
  saveDB(db);
  refreshAuctionLiveUI();
  // Full-screen player draw appears after a short delay
  setTimeout(() => { if (db.auction.live) openAuctionStage(); }, 4000);
});
resetAuctionBtn?.addEventListener("click", () => {
  if (!confirm("Reset the auction and return auction-bought players to the pool?")) return;
  resetAuctionAssignments();
  db.auction.live = false;
  db.auction.liveAt = null;
  stageQueue = [];
  stageCurrent = null;
  celebrating = false;
  saveDB(db);
  closeAuctionStage();
  updateUndoSaleButton();
  refreshAuctionLiveUI();
});
endAuctionBtn?.addEventListener("click", () => {
  db.auction.live = false;
  saveDB(db);
  closeAuctionStage();
  refreshAuctionLiveUI();
});

/* ---------- Matches / Scorecards ---------- */
function squadForTeam(teamName) {
  return getTeamSquad(teamName);
}
function squadNames(teamName) {
  return [...new Set(squadForTeam(teamName).map(p => p.name))];
}
function findMatch(id) { return (db.matches || []).find(m => m.id === id); }
function newMatch(team1, team2, date, overs, venue, tournament) {
  const inn = t => ({ batting: t, bowling: t === team1 ? team2 : team1, balls: [], striker: "", nonStriker: "", bowler: "", out: [], batters: [], bowlers: [], retired: [] });
  // Manually-added matches are always league matches. Playoff matches are created
  // by the app (createPlayoffs) and carry their own stage. Old saved matches have
  // no `stage` — matchStage() treats those as "league" so nothing crashes.
  return { id: uid(), team1, team2, date, overs, venue, tournament: tournament || "", status: "upcoming", stage: "league", innings: [inn(team1), inn(team2)], currentInnings: 0 };
}
function oversText(legal) { return `${Math.floor(legal / 6)}.${legal % 6}`; }
function isLegalBall(b) { return !(b.wide || b.noBall || b.extra === "wide" || b.extra === "noball"); }
function extrasBreakdown(inn) {
  const map = { wide: [0, 0], noball: [0, 0], bye: [0, 0], legbye: [0, 0], widebye: [0, 0] }; // [count, declared]
  (inn.balls || []).forEach(b => {
    if (b.extra && map[b.extra]) { map[b.extra][0]++; if (b.declared) map[b.extra][1]++; }
  });
  return map;
}
function inningsScore(inn) {
  let runs = 0, wkts = 0, legal = 0;
  (inn.balls || []).forEach(b => {
    runs += (b.runs || 0) + (b.wide ? 1 : 0) + (b.noBall ? 1 : 0);
    if (isLegalBall(b)) legal++;
    if (b.wicket) wkts++;
  });
  return { runs, wkts, legal, overs: oversText(legal) };
}
function inningsDone(m, inn, idx, firstInn) {
  const s = inningsScore(inn);
  const isSuper = !!inn.super;
  const maxBalls = isSuper ? 6 : (m.overs || 20) * 6;
  const maxWkts = isSuper ? 2 : Math.min(10, Math.max(1, squadNames(inn.batting).length - 1));
  if (s.legal >= maxBalls || s.wkts >= maxWkts) return true;
  // Chase: 2nd innings ends when target reached
  if (idx === 1) {
    const first = firstInn || m.innings[0];
    const target = inningsScore(first).runs + 1;
    if (s.runs >= target) return true;
  }
  return false;
}
function matchResult(m) {
  if (!m || m.innings.length < 2) return "";
  // Super over decides a tied match
  if (m.superOver && m.superOver.innings && m.superOver.innings.length === 2) {
    const so = m.superOver.innings;
    const done = inningsDone(m, so[0], 0, so[0]) && inningsDone(m, so[1], 1, so[0]);
    if (!done) return "Super Over in progress";
    const a = inningsScore(so[0]), b = inningsScore(so[1]);
    if (a.runs === b.runs) return "Super Over tied";
    const w2 = b.runs > a.runs;
    const w = w2 ? b : a, l = w2 ? a : b;
    const winner = w2 ? so[1].batting : so[0].batting;
    const wktsLeft = 2 - w.wkts;
    if (w2 && wktsLeft > 0 && w.runs >= a.runs + 1) {
      return `${winner} won the Super Over by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"}`;
    }
    const margin = w.runs - l.runs;
    return `${winner} won the Super Over by ${margin} run${margin === 1 ? "" : "s"}`;
  }
  if (m.status !== "completed") return "";
  const a = inningsScore(m.innings[0]), b = inningsScore(m.innings[1]);
  if (a.runs === b.runs) return "Match Tied";
  const w2 = b.runs > a.runs;
  const w = w2 ? b : a, l = w2 ? a : b;
  const winner = w2 ? m.team2 : m.team1;
  const target = a.runs + 1;
  const wktsAvail = squadNames(m.innings[1].batting).length - 1;
  const wktsLeft = wktsAvail - w.wkts;
  if (w2 && wktsLeft > 0 && w.runs >= target) {
    return `${winner} won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"}`;
  }
  const margin = w.runs - l.runs;
  return `${winner} won by ${margin} run${margin === 1 ? "" : "s"}`;
}
function playerName(id) { const p = db.players.find(x => x.id === id); return p ? p.name : "—"; }
function teamLogo(name) { const t = (db.teams || []).find(x => x.name === name); return t ? (t.logo || "") : ""; }
function playerPhoto(name) { const p = (db.players || []).find(x => x.name === name); return p ? (p.photo || "") : ""; }
function avatarImg(src, cls) { return src ? `<img class="${cls}" src="${src}" alt="" />` : ""; }
function playerTeam(name) { const p = (db.players || []).find(x => x.name === name); return p ? (p.soldTo || "") : ""; }
function capBadge(name, team) {
  // Only a real captain: captainFor must be a team name. Blank === blank was
  // marking every player with no team and no captain as captain.
  const cap = (db.players || []).find(p => p.name === name && p.captainFor);
  if (!cap) return "";
  if (team && cap.captainFor !== team) return "";
  return `<span class="cap-c" title="Captain">c</span>`;
}

// Man of the Match — winning team only; falls back to both teams when no winner.
// Points: runs + 25/wicket + 2/four + 4/six (all-rounders count batting + bowling).
function manOfTheMatch(m) {
  if (!m || m.status !== "completed") return null;
  const innList = [...(m.innings || [])];
  if (m.superOver && m.superOver.innings) innList.push(...m.superOver.innings);
  // Winner: super-over winner if decided there, else main innings; "" / "tie" → no winner
  const winner = (Array.isArray(m.innings) && m.innings.length >= 2) ? matchWinnerTeam(m) : null;
  const eligibleTeam = (winner && winner !== "tie") ? winner : null;
  const stats = {}; // name -> { team, runs, balls, fours, sixes, wkts, bowlRuns, bowlBalls }
  innList.forEach(inn => {
    (inn.balls || []).forEach(b => {
      if (b.extra) return;
      if (b.batter) {
        const p = stats[b.batter] = stats[b.batter] || { team: inn.batting, runs: 0, balls: 0, fours: 0, sixes: 0, wkts: 0, bowlRuns: 0, bowlBalls: 0 };
        p.runs += b.runs || 0;
        if (isLegalBall(b)) p.balls++;
        if (b.runs === 4) p.fours++;
        if (b.runs === 6) p.sixes++;
      }
      if (b.bowler) {
        const p = stats[b.bowler] = stats[b.bowler] || { team: inn.bowling, runs: 0, balls: 0, fours: 0, sixes: 0, wkts: 0, bowlRuns: 0, bowlBalls: 0 };
        p.wkts += b.wicket ? 1 : 0;
        p.bowlRuns += (b.runs || 0) + (b.wide ? 1 : 0) + (b.noBall ? 1 : 0);
        if (isLegalBall(b)) p.bowlBalls++;
      }
    });
  });
  let best = null;
  Object.entries(stats).forEach(([name, s]) => {
    if (eligibleTeam && s.team !== eligibleTeam) return; // losing team never eligible
    const pts = s.runs + s.wkts * 25 + s.fours * 2 + s.sixes * 4;
    if (!best || pts > best.pts ||
        (pts === best.pts && (s.wkts > best.s.wkts || (s.wkts === best.s.wkts && s.runs > best.s.runs)))) {
      best = { name, s, pts };
    }
  });
  if (!best || best.pts <= 0) return null;
  const bits = [];
  if (best.s.runs > 0) bits.push(`${best.s.runs} run${best.s.runs === 1 ? "" : "s"}`);
  if (best.s.wkts > 0) bits.push(`${best.s.wkts} wicket${best.s.wkts === 1 ? "" : "s"}`);
  return { name: best.name, team: best.s.team, why: bits.join(" · ") };
}

/* ---------- standings.html — points table + man of the matches ---------- */
function completedMatches() {
  return (db.matches || []).filter(m => m.status === "completed");
}

// Returns winning team name, "tie", or "" (undecided super over)
function matchWinnerTeam(m) {
  if (m.superOver && m.superOver.innings && m.superOver.innings.length === 2) {
    const so = m.superOver.innings;
    const done = inningsDone(m, so[0], 0, so[0]) && inningsDone(m, so[1], 1, so[0]);
    if (!done) return "";
    const a = inningsScore(so[0]), b = inningsScore(so[1]);
    if (a.runs === b.runs) return "tie";
    return b.runs > a.runs ? so[1].batting : so[0].batting;
  }
  const a = inningsScore(m.innings[0]), b = inningsScore(m.innings[1]);
  if (a.runs === b.runs) return "tie";
  return b.runs > a.runs ? m.innings[1].batting : m.innings[0].batting;
}

// Points: win=2, tie=1, loss=0. NRR across all completed matches; super over excluded.
// All-out innings count as the full overs quota for both batting and bowling.
function pointsTable() {
  const rows = {};
  const ensure = name => rows[name] = rows[name] || { played: 0, pts: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0 };
  completedMatches().forEach(m => {
    const quota = m.overs || 20;
    ensure(m.team1); ensure(m.team2);
    const winner = matchWinnerTeam(m);
    if (winner === "tie") { rows[m.team1].pts += 1; rows[m.team2].pts += 1; }
    else if (winner) rows[winner].pts += 2;
    rows[m.team1].played++; rows[m.team2].played++;
    (m.innings || []).forEach(inn => {
      const s = inningsScore(inn);
      const overs = s.wkts >= 10 ? quota : s.legal / 6;
      const bat = ensure(inn.batting), bowl = ensure(inn.bowling);
      bat.runsFor += s.runs; bat.oversFor += overs;
      bowl.runsAgainst += s.runs; bowl.oversAgainst += overs;
    });
  });
  return Object.entries(rows).map(([team, r]) => {
    const rrFor = r.oversFor ? r.runsFor / r.oversFor : 0;
    const rrAg = r.oversAgainst ? r.runsAgainst / r.oversAgainst : 0;
    const nrr = rrFor - rrAg;
    return { team, played: r.played, pts: r.pts, nrr };
  }).sort((a, b) => b.pts - a.pts || b.nrr - a.nrr);
}

/* ============================================================
 * FIXTURES + AUTOMATIC PLAYOFFS
 * 4 teams (first four in db.teams) → 10-match league (each team plays 5)
 * → 3 playoffs created by the app (Qualifier, Semi-final, Final).
 * ============================================================ */

// Every match carries a stage: league | qualifier | semifinal | final.
// Old saved matches have no stage → they count as league (no crash).
function matchStage(m) { return (m && m.stage) || "league"; }
function leagueMatches() { return (db.matches || []).filter(m => matchStage(m) === "league"); }
function findPlayoff(stage) { return (db.matches || []).find(m => matchStage(m) === stage); }
// A playoff match's teams may be edited only until it has actually started.
function playoffStarted(m) {
  if (!m) return false;
  if (m.status === "live" || m.status === "completed") return true;
  return (m.innings || []).some(i => (i.balls || []).length > 0);
}

// The four competing teams — T1..T4 = first four teams in db.teams
function topTeams() { return (db.teams || []).slice(0, 4).map(t => t.name); }

// Planned league fixtures, in order (indices into topTeams): Match 1..10
const FIXTURE_TEMPLATE = [
  [0, 1], [2, 3], [0, 3], [1, 2], [0, 2],
  [1, 3], [0, 1], [2, 3], [0, 3], [1, 2],
];
const FIXTURE_LIMIT = 10;   // league matches
const TEAM_LIMIT = 5;       // league matches per team
const pairKey = (a, b) => [a, b].sort().join("|");

// The league stage is complete ONLY when all 10 league matches exist and are all
// completed. Single gate for: playoff creation, the rank tags/highlights in the points
// table, and the Playoffs bracket/section (on both the points and matches pages).
function leagueComplete() {
  const league = leagueMatches();
  return league.length === FIXTURE_LIMIT && league.every(m => m.status === "completed");
}
// True once any playoff match has actually started — once started, the playoffs stay
// visible even if the league is later reset/edited so leagueComplete() becomes false.
function anyPlayoffStarted() {
  return ["qualifier", "semifinal", "final"].some(s => playoffStarted(findPlayoff(s)));
}

// Map each planned fixture to a real league match (matched by fixtureNo or teams + order).
function fixtureStatuses() {
  const teams = topTeams();
  if (teams.length < 4) return [];
  const league = leagueMatches();
  const assignedMatchIds = new Set();

  return FIXTURE_TEMPLATE.map((pair, i) => {
    const n = i + 1;
    const t1 = teams[pair[0]], t2 = teams[pair[1]];
    const sameTeams = m => pairKey(m.team1, m.team2) === pairKey(t1, t2);
    const hasFixtureNo = m => m.fixtureNo !== undefined && m.fixtureNo !== null && m.fixtureNo !== "";
    let match = league.find(m => !assignedMatchIds.has(m.id) && sameTeams(m) && Number(m.fixtureNo) === n);
    if (!match) {
      const candidates = league.filter(m => !assignedMatchIds.has(m.id) && !hasFixtureNo(m) && sameTeams(m));
      match = candidates[0] || null;
    }
    if (match) assignedMatchIds.add(match.id);
    let st = "Planned";
    if (match) {
      if (match.status === "completed") st = "Completed";
      else if (match.status === "live") st = "Live";
      else st = "Upcoming";
    }
    return { n, t1, t2, match: match || null, status: st };
  });
}
// League matches in fixture-plan order, with any extra league matches appended.
function orderedLeagueMatches() {
  const fx = fixtureStatuses();
  const ordered = [], seen = new Set();
  fx.forEach(f => { if (f.match && !seen.has(f.match.id)) { ordered.push(f.match); seen.add(f.match.id); } });
  const rest = leagueMatches().filter(m => !seen.has(m.id))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return [...ordered, ...rest];
}

// Full squad for a team, matching the auction table. Used to preload playoff matches.
function teamFullSquad(teamName) {
  return squadNames(teamName);
}
function refreshPlayoffSquads(m) {
  (m.innings || []).forEach(inn => {
    inn.batters = inn.batting ? teamFullSquad(inn.batting) : [];
    inn.bowlers = inn.bowling ? teamFullSquad(inn.bowling) : [];
    inn.striker = ""; inn.nonStriker = ""; inn.bowler = "";
  });
  m.currentInnings = 0;
}
// Keep team + innings batting/bowling pairs in sync, then reload the squads.
function applyPlayoffTeams(m, t1, t2) {
  m.team1 = t1; m.team2 = t2;
  if (!Array.isArray(m.innings) || m.innings.length < 2) {
    const inn = t => ({ batting: t, bowling: t === t1 ? t2 : t1, balls: [], striker: "", nonStriker: "", bowler: "", out: [], batters: [], bowlers: [], retired: [] });
    m.innings = [inn(t1), inn(t2)];
  }
  m.innings[0].batting = t1; m.innings[0].bowling = t2;
  m.innings[1].batting = t2; m.innings[1].bowling = t1;
  refreshPlayoffSquads(m);
}
function makePlayoffMatch(stage, team1, team2, def) {
  const m = newMatch(team1, team2, def.date, def.overs, def.venue, def.tournament);
  m.stage = stage;
  m.status = "upcoming";
  refreshPlayoffSquads(m); // load both squads so scoring can start without picking players
  return m;
}
function playoffDefaults() {
  const league = leagueMatches();
  const dates = league.map(m => m.date).filter(Boolean).sort();
  return {
    overs: league.length ? (league[0].overs || 20) : 20,
    venue: db.tournament.ground || (league.length ? (league[league.length - 1].venue || "") : ""),
    date: dates.length ? dates[dates.length - 1] : "",
    tournament: db.tournament.name || (league.length ? (league[0].tournament || "") : ""),
  };
}

// League-only points table: win=2, tie=1; super over counts as a win/loss for the
// result but its runs are excluded from NRR; a team bowled out bats the full quota.
function leaguePointsTable() {
  const rows = {};
  const ensure = name => rows[name] = rows[name] || { played: 0, won: 0, lost: 0, tied: 0, pts: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0 };
  leagueMatches().filter(m => m.status === "completed").forEach(m => {
    const quota = m.overs || 20;
    ensure(m.team1); ensure(m.team2);
    const winner = matchWinnerTeam(m);
    if (winner === "tie") {
      rows[m.team1].tied++; rows[m.team2].tied++; rows[m.team1].pts++; rows[m.team2].pts++;
    } else if (winner) {
      rows[winner].won++; rows[winner].pts += 2;
      const loser = winner === m.team1 ? m.team2 : m.team1;
      rows[loser].lost++;
    }
    rows[m.team1].played++; rows[m.team2].played++;
    (m.innings || []).forEach(inn => {
      const s = inningsScore(inn);
      const overs = s.wkts >= 10 ? quota : s.legal / 6;
      const bat = ensure(inn.batting), bowl = ensure(inn.bowling);
      bat.runsFor += s.runs; bat.oversFor += overs;
      bowl.runsAgainst += s.runs; bowl.oversAgainst += overs;
    });
  });
  return Object.entries(rows).map(([team, r]) => {
    const rrFor = r.oversFor ? r.runsFor / r.oversFor : 0;
    const rrAg = r.oversAgainst ? r.runsAgainst / r.oversAgainst : 0;
    return { team, played: r.played, won: r.won, lost: r.lost, tied: r.tied, pts: r.pts, nrr: rrFor - rrAg };
  }).sort((a, b) => b.pts - a.pts || b.nrr - a.nrr)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Create/fill the 3 playoff matches once the league is complete. Idempotent:
// never duplicates; refreshes the Qualifier teams while it hasn't started.
// Returns true when db was mutated (so the caller can persist via saveDB).
function createPlayoffs() {
  if (session.role !== "admin") return false;             // only the admin device writes
  if (!leagueComplete()) return false;                    // never before all 10 league matches are done
  const ranks = leaguePointsTable();
  if (ranks.length < 4) return false;
  const r = ranks.map(x => x.team);
  db.matches = db.matches || [];
  const def = playoffDefaults();
  let changed = false;

  // Match 11 — Qualifier: rank 3 vs rank 4
  let q = findPlayoff("qualifier");
  if (!q) { q = makePlayoffMatch("qualifier", r[2], r[3], def); db.matches.push(q); changed = true; }
  else if (!playoffStarted(q) && (q.team1 !== r[2] || q.team2 !== r[3])) { applyPlayoffTeams(q, r[2], r[3]); changed = true; }

  const qw = q.status === "completed" ? matchWinnerTeam(q) : "";
  const qwName = (qw && qw !== "tie") ? qw : "";

  // Match 12 — Semi-final: rank 2 vs Winner of Qualifier
  let sf = findPlayoff("semifinal");
  const sfT2 = qwName || "Winner of Qualifier";
  if (!sf) { sf = makePlayoffMatch("semifinal", r[1], sfT2, def); db.matches.push(sf); changed = true; }
  else if (!playoffStarted(sf) && (sf.team1 !== r[1] || sf.team2 !== sfT2)) { applyPlayoffTeams(sf, r[1], sfT2); changed = true; }

  const sfw = sf.status === "completed" ? matchWinnerTeam(sf) : "";
  const sfwName = (sfw && sfw !== "tie") ? sfw : "";

  // Match 13 — Final: rank 1 vs Winner of Semi-final
  let fin = findPlayoff("final");
  const finT2 = sfwName || "Winner of Semi-final";
  if (!fin) { fin = makePlayoffMatch("final", r[0], finT2, def); db.matches.push(fin); changed = true; }
  else if (!playoffStarted(fin) && (fin.team1 !== r[0] || fin.team2 !== finT2)) { applyPlayoffTeams(fin, r[0], finT2); changed = true; }

  return changed;
}

// Remove playoff matches created prematurely (league no longer complete) — but only if
// they have no scores and have not started. Tombstoned so the removal syncs everywhere.
function pruneStalePlayoffs() {
  if (leagueComplete()) return false;
  const stale = (db.matches || []).filter(m => matchStage(m) !== "league" && !playoffStarted(m));
  if (!stale.length) return false;
  const ids = new Set(stale.map(m => m.id));
  db.matches = (db.matches || []).filter(m => !ids.has(m.id));
  db.deletedMatches = mergeTombstones(db.deletedMatches, [...ids]);
  return true;
}

// Run from render/after scoring. Admin-only, re-entrancy-guarded, and only
// persists when something actually changed. Creates the playoffs only once the league is
// complete; otherwise prunes any premature placeholders.
let playoffsBusy = false;
function syncPlayoffs() {
  if (playoffsBusy || session.role !== "admin") return;
  playoffsBusy = true;
  try {
    const changed = leagueComplete() ? createPlayoffs() : pruneStalePlayoffs();
    if (changed) saveDB(db);
  } finally { playoffsBusy = false; }
}

// Bracket + champion data for the points page.
function bracketData() {
  const ranks = leaguePointsTable();
  const team = i => ranks[i] ? ranks[i].team : "";
  const fin = findPlayoff("final");
  const champion = (fin && fin.status === "completed" && matchWinnerTeam(fin) && matchWinnerTeam(fin) !== "tie")
    ? { team: matchWinnerTeam(fin), motm: manOfTheMatch(fin) } : null;
  return {
    rank1: team(0), rank2: team(1), rank3: team(2), rank4: team(3),
    qualifier: findPlayoff("qualifier"), semifinal: findPlayoff("semifinal"), final: fin,
    champion,
  };
}

// Per-player batting + bowling aggregates across all completed matches (incl. super overs)
function playerTournamentStats() {
  const players = {}; // name -> { bat:{...}, bowl:{...} }
  const ensure = n => players[n] = players[n] || {
    bat: { runs: 0, balls: 0, fours: 0, sixes: 0, inns: 0, bestScore: 0, bestSR: 0 },
    bowl: { wkts: 0, runs: 0, balls: 0, bestW: 0, bestR: Infinity, bestEcon: Infinity }
  };
  completedMatches().forEach(m => {
    const inns = [...(m.innings || [])];
    if (m.superOver && m.superOver.innings) inns.push(...m.superOver.innings);
    inns.forEach(inn => {
      const batIn = {}, bowlIn = {};
      (inn.balls || []).forEach(b => {
        if (b.batter && !b.extra) {
          const s = batIn[b.batter] = batIn[b.batter] || { runs: 0, balls: 0, fours: 0, sixes: 0 };
          s.runs += b.runs || 0;
          if (b.runs === 4) s.fours++;
          if (b.runs === 6) s.sixes++;
          if (isLegalBall(b)) s.balls++;
        }
        if (b.bowler && b.extra !== "bye" && b.extra !== "legbye") {
          const s = bowlIn[b.bowler] = bowlIn[b.bowler] || { wkts: 0, runs: 0, balls: 0 };
          s.runs += (b.runs || 0) + (b.wide ? 1 : 0) + (b.noBall ? 1 : 0);
          if (isLegalBall(b)) s.balls++;
          if (b.wicket && b.wicketType !== "run out") s.wkts++;
        }
      });
      Object.entries(batIn).forEach(([n, s]) => {
        const p = ensure(n).bat;
        p.runs += s.runs; p.balls += s.balls; p.fours += s.fours; p.sixes += s.sixes; p.inns++;
        if (s.runs > p.bestScore) p.bestScore = s.runs;
        if (s.balls) { const sr = (s.runs / s.balls) * 100; if (sr > p.bestSR) p.bestSR = sr; }
      });
      Object.entries(bowlIn).forEach(([n, s]) => {
        const p = ensure(n).bowl;
        p.wkts += s.wkts; p.runs += s.runs; p.balls += s.balls;
        if (s.wkts > 0 && (s.wkts > p.bestW || (s.wkts === p.bestW && s.runs < p.bestR))) { p.bestW = s.wkts; p.bestR = s.runs; }
        if (s.balls) { const e = s.runs / (s.balls / 6); if (e < p.bestEcon) p.bestEcon = e; }
      });
    });
  });
  return players;
}

// Every player in the tournament — all players merged with stats (zeros if none)
function tournamentPlayerRows() {
  const st = playerTournamentStats();
  const names = new Set([...Object.keys(st), ...(db.players || []).map(p => p.name).filter(Boolean)]);
  const zeroBat = { runs: 0, balls: 0, fours: 0, sixes: 0, inns: 0, bestScore: 0, bestSR: 0 };
  const zeroBowl = { wkts: 0, runs: 0, balls: 0, bestW: 0, bestR: Infinity, bestEcon: Infinity };
  return [...names].map(name => {
    const s = st[name] || {};
    return { name, bat: s.bat || { ...zeroBat }, bowl: s.bowl || { ...zeroBowl } };
  });
}

(function initStandingsPage() {
  const pointsEl = document.getElementById("points-table");
  const motmEl = document.getElementById("motm-list");
  const batEl = document.getElementById("bat-table");
  const bowlEl = document.getElementById("bowl-table");
  const allroundEl = document.getElementById("allround-table");
  const iconEl = document.getElementById("icon-table");
  const bracketEl = document.getElementById("playoff-bracket");
  const champEl = document.getElementById("champion-banner");
  if (!pointsEl && !motmEl && !batEl && !bowlEl && !allroundEl && !iconEl) return;

  // Rank → route: 1 = Final, 2 = Semi-final, 3 & 4 = Qualifier
  const rankTag = i => i === 0 ? `<span class="rank-tag rank-final" title="Goes straight to the Final">Final</span>`
    : i === 1 ? `<span class="rank-tag rank-semi" title="Semi-final">Semi</span>`
    : i <= 3 ? `<span class="rank-tag rank-qual" title="Qualifier">Qual</span>` : "";

  function renderPoints() {
    if (!pointsEl) return;
    const rows = leaguePointsTable();   // league matches only
    if (!rows.length) { pointsEl.innerHTML = `<div class="empty-state">No completed league matches yet.</div>`; return; }
    const complete = leagueComplete();  // Final/Semi/Qual tags + row highlights only once all 10 league matches are done
    pointsEl.innerHTML = `
      <table class="score-table standings-table">
        <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>T/NR</th><th>Pts</th><th>NRR</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr class="${complete ? `rank-${i + 1}` : ""}">
            <td>${i + 1}</td>
            <td><b>${esc(r.team)}</b> ${complete ? rankTag(i) : ""}</td>
            <td>${r.played}</td>
            <td>${r.won}</td>
            <td>${r.lost}</td>
            <td>${r.tied}</td>
            <td><b>${r.pts}</b></td>
            <td class="${r.nrr >= 0 ? "nrr-pos" : "nrr-neg"}">${r.nrr >= 0 ? "+" : ""}${r.nrr.toFixed(3)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  // Trophy banner once the Final is decided
  function renderChampion() {
    if (!champEl) return;
    const bd = bracketData();
    if (bd.champion) {
      const motm = bd.champion.motm;
      champEl.classList.remove("hidden");
      champEl.innerHTML = `🏆 Champions: <b>${esc(bd.champion.team)}</b>` +
        (motm ? `<span class="champ-motm">Man of the Match: <b>${esc(motm.name)}</b> <span class="motm-why">(${esc(motm.why)})</span></span>` : "");
    } else {
      champEl.classList.add("hidden");
      champEl.innerHTML = "";
    }
  }

  // Qualifier → Semi-final → Final; rank 1 feeds straight into the Final.
  // Hidden (heading + bracket + qualification line) until the league is complete,
  // unless a playoff has already started.
  function renderBracket() {
    if (!bracketEl) return;
    const showPlayoffs = leagueComplete() || anyPlayoffStarted();
    document.querySelector(".bracket-head")?.classList.toggle("hidden", !showPlayoffs);
    if (!showPlayoffs) {
      const done = leagueMatches().filter(m => m.status === "completed").length;
      bracketEl.innerHTML = `<div class="empty-state bracket-pending">Playoffs will appear after all 10 league matches are completed (${done} / ${FIXTURE_LIMIT} done).</div>`;
      return;
    }
    const bd = bracketData();
    const slot = (name, sub) => name
      ? `<span class="br-team">${esc(name)}</span>`
      : `<span class="br-team br-tbd">${esc(sub)}</span>`;
    const card = (label, t1, t2, m, sub2) => {
      const st = m ? m.status : "upcoming";
      return `<div class="br-card">
        <div class="br-label">${esc(label)}<span class="badge match-status ${st === "completed" ? "done" : st === "live" ? "live" : ""}">${st}</span></div>
        <div class="br-slot">${slot(t1, "To be decided")}</div>
        <div class="br-vs">vs</div>
        <div class="br-slot">${slot(t2, sub2)}</div>
      </div>`;
    };
    const q = bd.qualifier, sf = bd.semifinal, fin = bd.final;
    bracketEl.innerHTML = `
      <div class="bracket-row">
        ${card("Qualifier", q ? q.team1 : bd.rank3, q ? q.team2 : bd.rank4, q, "To be decided")}
        <div class="br-arrow">→</div>
        ${card("Semi-final", sf ? sf.team1 : bd.rank2, sf ? sf.team2 : "", sf, "Winner of Qualifier")}
        <div class="br-arrow">→</div>
        ${card("Final", fin ? fin.team1 : bd.rank1, fin ? fin.team2 : "", fin, "Winner of Semi-final")}
      </div>
      <div class="bracket-note">Rank 1 (${esc(bd.rank1 || "—")}) goes straight to the Final · Rank 2 (${esc(bd.rank2 || "—")}) to the Semi-final · Ranks 3 &amp; 4 (${esc(bd.rank3 || "—")} / ${esc(bd.rank4 || "—")}) to the Qualifier.</div>`;
  }

  function renderMotm() {
    if (!motmEl) return;
    const list = completedMatches().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (!list.length) { motmEl.innerHTML = `<div class="empty-state">No completed matches yet.</div>`; return; }
    motmEl.innerHTML = "";
    list.forEach(m => {
      const motm = manOfTheMatch(m);
      const el = document.createElement("a");
      el.className = "item motm-match-link";
      el.href = `match.html?id=${encodeURIComponent(m.id)}`;
      el.setAttribute("aria-label", `Open scorecard: ${m.team1} vs ${m.team2}`);
      el.innerHTML = `
        <div class="item-main">
          <div class="item-title">${esc(m.team1)} <span class="vs">vs</span> ${esc(m.team2)}</div>
          <div class="item-sub">${esc(m.date || "—")} · ${esc(m.venue || "—")}</div>
        </div>
        <div class="item-actions">
          <span class="motm-badge">🏆 ${motm ? `${avatarImg(playerPhoto(motm.name), "tbl-avatar")}${esc(motm.name)}${motm.team ? ` <span class="motm-team">(${esc(motm.team)})</span>` : ""}` : "—"}</span>
        </div>`;
      motmEl.appendChild(el);
    });
  }

  function renderBat() {
    if (!batEl) return;
    const rows = tournamentPlayerRows()
      .map(r => ({ name: r.name, ...r.bat }))
      .sort((a, b) => b.runs - a.runs || b.bestSR - a.bestSR);
    if (!rows.length) { batEl.innerHTML = `<div class="empty-state">No players in this tournament yet.</div>`; return; }
    batEl.innerHTML = `
      <table class="score-table standings-table">
        <thead><tr><th>#</th><th>Player</th><th>Inns</th><th>Runs</th><th>4s</th><th>6s</th><th>Avg</th><th>SR</th><th>Best</th><th>Best SR</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><div class="player-cell">${avatarImg(playerPhoto(r.name), "tbl-avatar")}<div class="player-info"><div class="player-name-row">${capBadge(r.name, playerTeam(r.name))}${esc(r.name)}</div>${playerTeam(r.name) ? `<div class="player-team">${esc(playerTeam(r.name))}</div>` : ""}</div></div></td>
            <td>${r.inns}</td>
            <td>${r.runs}</td>
            <td>${r.fours}</td>
            <td>${r.sixes}</td>
            <td>${r.inns ? (r.runs / r.inns).toFixed(2) : "—"}</td>
            <td>${r.balls ? ((r.runs / r.balls) * 100).toFixed(1) : "—"}</td>
            <td>${r.bestScore || "—"}</td>
            <td>${r.bestSR ? r.bestSR.toFixed(1) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function renderBowl() {
    if (!bowlEl) return;
    const rows = tournamentPlayerRows()
      .map(r => ({ name: r.name, ...r.bowl }))
      .sort((a, b) => b.wkts - a.wkts || (a.wkts ? a.runs / a.wkts : Infinity) - (b.wkts ? b.runs / b.wkts : Infinity));
    if (!rows.length) { bowlEl.innerHTML = `<div class="empty-state">No players in this tournament yet.</div>`; return; }
    bowlEl.innerHTML = `
      <table class="score-table standings-table">
        <thead><tr><th>#</th><th>Player</th><th>Overs</th><th>Wkts</th><th>Runs</th><th>Avg</th><th>Econ</th><th>Best Fig</th><th>Best Econ</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><div class="player-cell">${avatarImg(playerPhoto(r.name), "tbl-avatar")}<div class="player-info"><div class="player-name-row">${capBadge(r.name, playerTeam(r.name))}${esc(r.name)}</div>${playerTeam(r.name) ? `<div class="player-team">${esc(playerTeam(r.name))}</div>` : ""}</div></div></td>
            <td>${oversText(r.balls)}</td>
            <td>${r.wkts}</td>
            <td>${r.runs}</td>
            <td>${r.wkts ? (r.runs / r.wkts).toFixed(2) : "—"}</td>
            <td>${r.balls ? (r.runs / (r.balls / 6)).toFixed(2) : "—"}</td>
            <td>${r.bestW ? `${r.bestW}/${r.bestR}` : "—"}</td>
            <td>${r.bestEcon === Infinity ? "—" : r.bestEcon.toFixed(2)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function renderAllround() {
    if (!allroundEl) return;
    const rows = tournamentPlayerRows()
      .map(r => ({ name: r.name, bat: r.bat, bowl: r.bowl, impact: r.bat.runs + r.bowl.wkts * 25 }))
      .sort((a, b) => b.impact - a.impact);
    if (!rows.length) { allroundEl.innerHTML = `<div class="empty-state">No players in this tournament yet.</div>`; return; }
    allroundEl.innerHTML = `
      <table class="score-table standings-table">
        <thead><tr><th>#</th><th>Player</th><th>Runs</th><th>4s</th><th>6s</th><th>Avg</th><th>SR</th><th>Wkts</th><th>Best Fig</th><th>Avg Econ</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><div class="player-cell">${avatarImg(playerPhoto(r.name), "tbl-avatar")}<div class="player-info"><div class="player-name-row">${capBadge(r.name, playerTeam(r.name))}${esc(r.name)}</div>${playerTeam(r.name) ? `<div class="player-team">${esc(playerTeam(r.name))}</div>` : ""}</div></div></td>
            <td>${r.bat.runs || "—"}</td>
            <td>${r.bat.fours || "—"}</td>
            <td>${r.bat.sixes || "—"}</td>
            <td>${r.bat.inns ? (r.bat.runs / r.bat.inns).toFixed(2) : "—"}</td>
            <td>${r.bat.balls ? ((r.bat.runs / r.bat.balls) * 100).toFixed(1) : "—"}</td>
            <td>${r.bowl.wkts || "—"}</td>
            <td>${r.bowl.bestW ? `${r.bowl.bestW}/${r.bowl.bestR}` : "—"}</td>
            <td>${r.bowl.balls ? (r.bowl.runs / (r.bowl.balls / 6)).toFixed(2) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function renderIcon() {
    if (!iconEl) return;
    // Icon player per team: player.iconFor === team name, fallback team.iconPlayer
    const iconNames = new Set();
    (db.teams || []).forEach(t => {
      const p = (db.players || []).find(x => x.iconFor === t.name)
        || (db.players || []).find(x => x.id === t.iconPlayer || x.name === t.iconPlayer);
      if (p) iconNames.add(p.name);
      else if (t.iconPlayer) iconNames.add(t.iconPlayer);
    });
    (db.players || []).forEach(p => { if (p.iconFor && !iconNames.size) iconNames.add(p.name); });
    const rows = tournamentPlayerRows()
      .filter(r => iconNames.has(r.name))
      .map(r => ({ name: r.name, bat: r.bat, bowl: r.bowl, impact: r.bat.runs + r.bowl.wkts * 25 }))
      .sort((a, b) => b.impact - a.impact);
    if (!rows.length) { iconEl.innerHTML = `<div class="empty-state">No icon players assigned yet.</div>`; return; }
    iconEl.innerHTML = `
      <table class="score-table standings-table">
        <thead><tr><th>#</th><th>Player</th><th>Runs</th><th>4s</th><th>6s</th><th>Avg</th><th>SR</th><th>Wkts</th><th>Best Fig</th><th>Avg Econ</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><div class="player-cell">${avatarImg(playerPhoto(r.name), "tbl-avatar")}<div class="player-info"><div class="player-name-row">${capBadge(r.name, playerTeam(r.name))}${esc(r.name)}</div>${playerTeam(r.name) ? `<div class="player-team">${esc(playerTeam(r.name))}</div>` : ""}</div></div></td>
            <td>${r.bat.runs || "—"}</td>
            <td>${r.bat.fours || "—"}</td>
            <td>${r.bat.sixes || "—"}</td>
            <td>${r.bat.inns ? (r.bat.runs / r.bat.inns).toFixed(2) : "—"}</td>
            <td>${r.bat.balls ? ((r.bat.runs / r.bat.balls) * 100).toFixed(1) : "—"}</td>
            <td>${r.bowl.wkts || "—"}</td>
            <td>${r.bowl.bestW ? `${r.bowl.bestW}/${r.bowl.bestR}` : "—"}</td>
            <td>${r.bowl.balls ? (r.bowl.runs / (r.bowl.balls / 6)).toFixed(2) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function render() {
    syncPlayoffs();  // admin: create/fill playoffs as soon as the league completes
    renderPoints(); renderChampion(); renderBracket();
    renderMotm(); renderBat(); renderBowl(); renderAllround(); renderIcon();
  }

  const TABS = ["points", "motm", "bat", "bowl", "allround", "icon"];
  function activateTab(t) {
    if (!TABS.includes(t)) t = "points";
    document.querySelectorAll(".standings-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    TABS.forEach(x => document.getElementById(`tab-${x}`)?.classList.toggle("hidden", x !== t));
    if (location.hash !== `#${t}`) history.replaceState(null, "", `#${t}`);
  }
  document.querySelectorAll(".standings-tab").forEach(btn => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));
  activateTab((location.hash || "").replace("#", ""));

  window.__renderStandings = render;
  render();
})();

/* ---------- matches.html ---------- */
(function initMatchesPage() {
  const listEl = document.getElementById("matches-list");
  const myListEl = document.getElementById("my-matches-list");
  const playoffsEl = document.getElementById("playoffs-list");
  const fixturesEl = document.getElementById("fixtures-list");
  const fixturesCounterEl = document.getElementById("fixtures-counter");
  const addBtn = document.getElementById("add-match");
  const form = document.getElementById("match-form");
  if (!listEl && !myListEl) return;

  // Role gating: Add Match = admin only; My Matches = owners only
  addBtn?.classList.toggle("hidden", session.role !== "admin");
  document.getElementById("my-matches-section")?.classList.toggle("hidden", session.role !== "owner");

  const STAGE_LABEL = { league: "League", qualifier: "Qualifier", semifinal: "Semi-final", final: "Final" };

  function matchCard(m, opts = {}) {
    const el = document.createElement("div");
    el.className = "item match-item";
    el.dataset.matchId = m.id;
    el.tabIndex = 0;
    el.setAttribute("role", "link");
    el.setAttribute("aria-label", `Open scorecard: ${m.team1} vs ${m.team2}`);
    const stage = matchStage(m);
    const scores = (m.innings || []).map(inningsScore);
    const scoreLine = scores.map((s, i) =>
      `${esc(m.innings[i].batting)} ${s.runs}/${s.wkts} (${s.overs})`).join(" vs ");
    const statusCls = { upcoming: "", live: "live", completed: "done" }[m.status] || "";
    const stageBadge = `<span class="badge stage-badge stage-${stage}">${STAGE_LABEL[stage] || "League"}</span>`;
    // Playoff matches are created/removed by the app only — no manual Delete.
    const canDelete = session.role === "admin" && stage === "league" && !opts.noDelete;
    el.innerHTML = `
      <div class="item-main">
        <div class="item-title">${esc(m.team1)} <span class="vs">vs</span> ${esc(m.team2)}
          ${stageBadge}
          <span class="badge match-status ${statusCls}">${m.status}</span></div>
        <div class="item-sub">${esc(m.date || "—")} · ${esc(m.venue || "—")} · ${m.overs || 20} overs${m.tournament ? ` · 🏆 ${esc(m.tournament)}` : ""}</div>
        ${m.status !== "upcoming" ? `<div class="item-sub score-line">${scoreLine}</div>` : ""}
        ${m.status === "completed" ? `<div class="item-sub result-line">${esc(matchResult(m))}</div>` : ""}
      </div>
      <div class="item-actions">
        <a class="btn btn-edit" href="match.html?id=${m.id}">Scorecard</a>
        ${canDelete ? `<button class="btn btn-danger" data-del-match="${m.id}">Delete</button>` : ""}
      </div>`;
    return el;
  }

  // Ensure the Team 1 / Team 2 selects have options (db.teams may arrive after load).
  function fillMatchFormTeams() {
    if (!form) return;
    const teamOpts = db.teams.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    form.querySelectorAll('select[name="team1"], select[name="team2"]').forEach(s => {
      if (s.options.length <= 1) s.innerHTML = `<option value="">— Select —</option>` + teamOpts;
    });
  }

  // Fixtures checklist — the plan the admin follows, with an "Add" button per row.
  function renderFixtures() {
    if (!fixturesEl) return;
    const teams = topTeams();
    document.getElementById("fixtures-card")?.classList.toggle("hidden", teams.length < 4);
    if (teams.length < 4) {
      fixturesEl.innerHTML = `<div class="empty-state">Add at least 4 teams to see the fixtures plan.</div>`;
      if (fixturesCounterEl) fixturesCounterEl.textContent = "";
      return;
    }
    const fx = fixtureStatuses();
    fixturesEl.innerHTML = fx.map(f => {
      const result = f.status === "Completed" && Array.isArray(f.match?.innings)
        ? matchResult(f.match)
        : "";
      return `
      <div class="fixture-row ${f.match ? "is-added is-clickable" : ""}"${f.match ? ` data-match-id="${esc(f.match.id)}" tabindex="0" role="link" aria-label="View scorecard: Match ${f.n}, ${esc(f.t1)} vs ${esc(f.t2)}"` : ""}>
        <span class="fixture-num">${f.n}</span>
        <span class="fixture-teams">${esc(f.t1)} <span class="vs">vs</span> ${esc(f.t2)}</span>
        <span class="fixture-status fx-${f.status.toLowerCase()}">${f.status}</span>
        ${f.status === "Completed" || f.status === "Live" ? `<span class="fixture-hint">View scorecard ›</span>` : ""}
        ${result ? `<span class="fixture-result">${esc(result)}</span>` : ""}
        ${session.role === "admin" && !f.match ? `<button class="btn btn-edit fixture-add" data-fx-add="${f.n}">Add</button>` : ""}
      </div>`;
    }).join("");
    if (fixturesCounterEl) {
      const league = leagueMatches();
      const per = teams.map(t => `${esc(t)}: ${league.filter(m => m.team1 === t || m.team2 === t).length}/${TEAM_LIMIT}`).join(" · ");
      fixturesCounterEl.innerHTML = `League matches added: <b>${league.length} / ${FIXTURE_LIMIT}</b><span class="fx-per">${per}</span>`;
    }
  }

  function render() {
    syncPlayoffs();  // admin: create/fill playoffs the moment the league completes
    fillMatchFormTeams(); // re-fill the form team selects if db.teams arrived after load
    const all = [...(db.matches || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    // Re-resolve owner team on every render — db.teams may arrive via Supabase after page load
    const ownerTeam = session.role === "owner"
      ? db.teams.find(t => (t.email || "").trim().toLowerCase() === (session.email || "").trim().toLowerCase())
      : null;
    if (listEl) {
      listEl.innerHTML = "";
      const league = orderedLeagueMatches();   // league section, in fixture order (Matches 1..10)
      if (!league.length) listEl.innerHTML = `<div class="empty-state">No league matches yet.${session.role === "admin" ? " Use the Fixtures list above to add them." : ""}</div>`;
      league.forEach(m => listEl.appendChild(matchCard(m)));
    }
    // Playoffs section is hidden entirely until the league is complete (or a playoff has
    // already started) — so no playoff cards appear after only a few league matches.
    const showPlayoffs = leagueComplete() || anyPlayoffStarted();
    document.getElementById("playoffs-section")?.classList.toggle("hidden", !showPlayoffs);
    if (playoffsEl) {
      playoffsEl.innerHTML = "";
      if (showPlayoffs) {
        const playoffs = ["qualifier", "semifinal", "final"].map(findPlayoff).filter(Boolean);
        // Champion banner once the Final is decided (visible to everyone)
        const bd = bracketData();
        if (bd.champion) {
          const motm = bd.champion.motm;
          playoffsEl.insertAdjacentHTML("beforeend",
            `<div class="champion-banner">🏆 Champions: <b>${esc(bd.champion.team)}</b>` +
            (motm ? `<span class="champ-motm">Man of the Match: <b>${esc(motm.name)}</b></span>` : "") + `</div>`);
        }
        if (!playoffs.length) {
          playoffsEl.insertAdjacentHTML("beforeend",
            `<div class="empty-state">Playoffs appear automatically once all 10 league matches are completed.</div>`);
        }
        playoffs.forEach(m => playoffsEl.appendChild(matchCard(m, { noDelete: true })));
      }
    }
    renderFixtures();
    if (myListEl) {
      myListEl.innerHTML = "";
      const mine = all.filter(m => ownerTeam && (m.team1 === ownerTeam.name || m.team2 === ownerTeam.name));
      if (!mine.length) myListEl.innerHTML = `<div class="empty-state">No matches for your team yet.</div>`;
      mine.forEach(m => myListEl.appendChild(matchCard(m)));
    }
  }

  // Team dropdowns in the add form
  if (form) {
    fillMatchFormTeams(); // populate team1/team2 (shared with render)
    // Tournament dropdown — all known tournaments (main tournament + match/ team associations)
    const tournSel = form.querySelector('select[name="tournament"]');
    if (tournSel) {
      const names = new Set();
      if (db.tournament.name) names.add(db.tournament.name);
      (db.matches || []).forEach(m => m.tournament && names.add(m.tournament));
      (db.teams || []).forEach(t => t.tournament && names.add(t.tournament));
      const cur = tournSel.value;
      tournSel.innerHTML = `<option value="">— None —</option>` +
        [...names].map(n => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
      if (!cur && db.tournament.name) tournSel.value = db.tournament.name;
    }
  }

  form?.querySelectorAll('select[name="team1"], select[name="team2"]').forEach(select => {
    select.addEventListener("change", () => { delete form.dataset.fixtureNo; });
  });
  addBtn?.addEventListener("click", () => {
    if (form) delete form.dataset.fixtureNo;
    form.classList.toggle("hidden");
    listEl?.classList.toggle("hidden", !form.classList.contains("hidden"));
    myListEl?.classList.toggle("hidden", !form.classList.contains("hidden"));
  });
  form?.querySelector("[data-cancel]")?.addEventListener("click", () => {
    delete form.dataset.fixtureNo;
    form.classList.add("hidden");
    listEl?.classList.remove("hidden");
    myListEl?.classList.remove("hidden");
  });

  // Fixtures "Add" → open the existing + Add Match form with the two teams pre-filled
  // (the admin still enters date / time / ground / overs and saves it manually).
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-fx-add]");
    if (!btn || session.role !== "admin" || !form) return;
    const n = Number(btn.dataset.fxAdd);
    const pair = FIXTURE_TEMPLATE[n - 1];
    const teams = topTeams();
    if (!pair || teams.length < 4) return;
    form.querySelector('select[name="team1"]').value = teams[pair[0]];
    form.querySelector('select[name="team2"]').value = teams[pair[1]];
    form.dataset.fixtureNo = String(n);
    form.classList.remove("hidden");
    listEl?.classList.add("hidden");
    myListEl?.classList.add("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  form?.addEventListener("submit", e => {
    e.preventDefault();
    const fd = new FormData(form);
    const team1 = fd.get("team1"), team2 = fd.get("team2");
    if (!team1 || !team2) { showToast("Select both teams"); return; }
    if (team1 === team2) { showToast("Teams must be different"); return; }
    // League-stage limits: max 10 league matches, max 5 per team.
    const leagueNow = leagueMatches();
    if (leagueNow.length >= FIXTURE_LIMIT) { showToast(`League stage is full — all ${FIXTURE_LIMIT} league matches are already added`); return; }
    const overQuota = [team1, team2].find(t => leagueNow.filter(m => m.team1 === t || m.team2 === t).length >= TEAM_LIMIT);
    if (overQuota) { showToast(`${overQuota} already has ${TEAM_LIMIT} league matches`); return; }
    db.matches = db.matches || [];
    const createdMatch = newMatch(team1, team2, fd.get("date") || "", Number(fd.get("overs")) || 20, fd.get("venue") || "", fd.get("tournament") || "");
    const fixtureNo = Number(form.dataset.fixtureNo);
    const fixturePair = FIXTURE_TEMPLATE[fixtureNo - 1];
    if (fixturePair && pairKey(team1, team2) === pairKey(topTeams()[fixturePair[0]], topTeams()[fixturePair[1]])) {
      createdMatch.fixtureNo = fixtureNo;
    }
    db.matches.push(createdMatch);
    saveDB(db);
    form.reset();
    delete form.dataset.fixtureNo;
    const tournSel2 = form.querySelector('select[name="tournament"]');
    if (tournSel2 && db.tournament.name) tournSel2.value = db.tournament.name;
    form.classList.add("hidden");
    listEl?.classList.remove("hidden");
    myListEl?.classList.remove("hidden");
    render();
    showToast("Match created");
  });

  document.addEventListener("click", e => {
    const del = e.target.closest("[data-del-match]");
    if (del && session.role === "admin") {
      const delId = del.dataset.delMatch;
      const m = (db.matches || []).find(x => x.id === delId);
      if (m && matchStage(m) !== "league") { showToast("Playoff matches cannot be deleted"); return; }
      const label = m ? `${m.team1} vs ${m.team2}` : "this match";
      if (!confirm(`Delete ${label}? All scorecard data and stats will be removed.`)) return;
      db.matches = (db.matches || []).filter(x => x.id !== delId);
      db.deletedMatches = mergeTombstones(db.deletedMatches, [delId]);
      saveDB(db);                       // localStorage + Supabase upsert (tombstone included)
      render();
      window.__renderStandings?.();     // standings/batting/bowling revert immediately
      window.__renderMatch?.();
      showToast("Match deleted — stats reverted");
    }
  });

  // Whole match card is clickable → opens its scorecard (single delegated listener).
  // Buttons/links inside a card (Scorecard, Delete, admin actions) keep their own behaviour.
  const cardHost = (listEl || myListEl).closest("main") || document;
  const scorecardUrl = id => `match.html?id=${encodeURIComponent(id)}`;
  const isCardControl = t => !!t.closest("button, a, select, input, textarea, label");
  const isFixtureControl = t => !!t.closest("button, a, select, input");
  fixturesEl?.addEventListener("click", e => {
    if (isFixtureControl(e.target)) return;
    const row = e.target.closest(".fixture-row[data-match-id]");
    if (!row) return;
    const url = scorecardUrl(row.dataset.matchId);
    if (e.metaKey || e.ctrlKey) window.open(url, "_blank");
    else location.href = url;
  });
  fixturesEl?.addEventListener("auxclick", e => {
    if (e.button !== 1 || isFixtureControl(e.target)) return;
    const row = e.target.closest(".fixture-row[data-match-id]");
    if (row) window.open(scorecardUrl(row.dataset.matchId), "_blank");
  });
  fixturesEl?.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".fixture-row[data-match-id]");
    if (!row || e.target !== row) return;
    e.preventDefault();
    location.href = scorecardUrl(row.dataset.matchId);
  });
  cardHost.addEventListener("click", e => {
    if (isCardControl(e.target)) return;
    const card = e.target.closest(".match-item[data-match-id]");
    if (!card) return;
    const url = scorecardUrl(card.dataset.matchId);
    if (e.metaKey || e.ctrlKey) window.open(url, "_blank");   // Ctrl/Cmd+click → new tab
    else location.href = url;                                 // normal click → same tab
  });
  cardHost.addEventListener("auxclick", e => {                // middle click → new tab
    if (e.button !== 1 || isCardControl(e.target)) return;
    const card = e.target.closest(".match-item[data-match-id]");
    if (card) window.open(scorecardUrl(card.dataset.matchId), "_blank");
  });
  cardHost.addEventListener("keydown", e => {                 // Enter / Space on a focused card
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".match-item[data-match-id]");
    if (!card || e.target !== card) return;                   // ignore keys inside inner controls
    e.preventDefault();
    location.href = scorecardUrl(card.dataset.matchId);
  });

  window.__renderMatches = render;
  render();
})();

/* ---------- match.html — scorecard + admin ball entry ---------- */
(function initMatchPage() {
  const scorecardEl = document.getElementById("scorecard");
  if (!scorecardEl) return;
  const params = new URLSearchParams(location.search);
  const matchId = params.get("id");
  let m = findMatch(matchId);
  // m may be null until Supabase syncs — renderAll() re-resolves and shows "not found" only then

  const isAdmin = session.role === "admin";
  const entryEl = document.getElementById("ball-entry");
  const inn = m && Array.isArray(m.innings) ? m.innings[m.currentInnings] : null;

  /* ---------- Mini ball animations inside scoring buttons + viewer badge ---------- */
  const WICONS = {
    bowled: `<svg class="wicon" viewBox="0 0 26 20"><g class="wstumps"><rect x="8" y="7" width="2.2" height="11"/><rect x="12" y="7" width="2.2" height="11"/><rect x="16" y="7" width="2.2" height="11"/></g><g class="wbails"><rect x="7" y="5" width="13" height="1.7"/><rect x="7" y="8.6" width="13" height="1.7"/></g><circle class="wball" cx="12" cy="19.5" r="2.8"/></svg>`,
    runout: `<svg class="wicon" viewBox="0 0 26 20"><g class="wstumps"><rect x="8" y="7" width="2.2" height="11"/><rect x="12" y="7" width="2.2" height="11"/><rect x="16" y="7" width="2.2" height="11"/></g><g class="wbails"><rect x="7" y="5" width="13" height="1.7"/><rect x="7" y="8.6" width="13" height="1.7"/></g><circle class="wball" cx="23.5" cy="12" r="2.8"/></svg>`,
    stumped: `<svg class="wicon" viewBox="0 0 26 20"><g class="wstumps"><rect x="8" y="7" width="2.2" height="11"/><rect x="12" y="7" width="2.2" height="11"/><rect x="16" y="7" width="2.2" height="11"/></g><g class="wbails"><rect x="7" y="5" width="13" height="1.7"/><rect x="7" y="8.6" width="13" height="1.7"/></g><path class="wglove" d="M20 9c3.5-1 4.5 2.5 2.2 4.6-1.2 1.1-3.4 1-4.4-.2l2.2-4.4z"/></svg>`,
    caught: `<svg class="wicon" viewBox="0 0 26 20"><circle class="wball" cx="8" cy="5.5" r="2.8"/><path class="wglove" d="M13 11c4.5-1 6.5 2.5 4.2 5.6-1.3 1.7-4.6 1.8-5.9.2l1.7-5.8z"/></svg>`,
    other: `<svg class="wicon" viewBox="0 0 26 20"><g class="wstumps"><rect x="8" y="7" width="2.2" height="11"/><rect x="12" y="7" width="2.2" height="11"/><rect x="16" y="7" width="2.2" height="11"/></g><circle class="wflash" cx="12" cy="13" r="3.2"/></svg>`,
  };
  const badgeEl = document.getElementById("last-ball-badge");
  const wicketUI = {}; // P → {type, open, out, newName, runs, ends} — survives renderAll rebuilds
  let lastBallTs = 0;
  let stagePrimed = false; // first renderAll = page load → prime ts, never replay

  function classifyDelivery(b) {
    if (b.wicket) return "wicket-" + String(b.wicketType || "other").toLowerCase().replace(/\s+/g, "-");
    if (b.extra === "widebye") return "widebye";
    if (b.extra === "wide" || b.wide) return "wide";
    if (b.extra === "noball" || b.noBall) return "noball";
    if (b.extra === "bye") return "bye";
    if (b.extra === "legbye") return "legbye";
    const r = b.runs || 0;
    if (r === 4) return "four";
    if (r === 6) return "six";
    return "runs" + r;
  }
  function labelFor(b, kind) {
    const dec = b.declared ? " ✦DECLARED" : "";
    if (kind.startsWith("wicket-")) {
      const t = kind.slice(7);
      const map = { bowled: "BOWLED!", caught: "CAUGHT!", stumped: "STUMPED!", "run-out": "RUN OUT!", other: `OUT! ${b.wicketType || ""}`.trim() };
      return { text: (map[t] || "OUT!") + dec, cls: "wicket" };
    }
    if (kind === "four") return { text: "FOUR!" + dec, cls: "four" };
    if (kind === "six") return { text: "SIX!" + dec, cls: "six" };
    if (kind === "wide") return { text: "WD" + dec, cls: "extra" };
    if (kind === "noball") return { text: "NB" + (b.declared ? "" : (b.runs ? "+" + b.runs : "")) + dec, cls: "extra" };
    if (kind === "bye") return { text: "B" + dec, cls: "extra" };
    if (kind === "legbye") return { text: "LB" + dec, cls: "extra" };
    const r = b.runs || 0;
    return { text: (r === 0 ? "•" : String(r)) + dec, cls: "run" };
  }
  // Spawn ball(s) that fly up out of the button and fade — never blocks scoring
  function flyBall(btn, variant = "", count = 1) {
    const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const b = document.createElement("i");
        b.className = "btn-ball fly" + (variant ? " fly-" + variant : "") + (reduced ? " fly-fade" : "");
        btn.appendChild(b);
        b.addEventListener("animationend", () => b.remove());
      }, i * 80);
    }
  }
  // Fires once per new delivery: viewer badge + admin button micro-animation
  function animateDeliveryUI(lb) {
    const kind = classifyDelivery(lb);
    const lbl = labelFor(lb, kind);
    const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Viewer badge (everyone sees it — same delivery indicator)
    if (badgeEl) {
      badgeEl.classList.remove("hidden");
      badgeEl.dataset.anim = reduced ? "static" : kind;
      const t = badgeEl.querySelector(".lb-text");
      if (t) t.textContent = lbl.text;
      clearTimeout(badgeEl._t);
      badgeEl._t = setTimeout(() => { badgeEl.dataset.anim = ""; }, 1400);
    }
    // Admin pad: animate the exact button that was used
    if (isAdmin && entryEl && lb.super !== undefined) {
      const pad = document.getElementById(`${lb.super ? "so" : "inn"}-entry-${lb.idx}`);
      if (!pad) return;
      let btn = null, animCls = "";
      if (lb.wicket) {
        const wt = String(lb.wicketType || "other");
        btn = pad.querySelector(`.wicket-pill[data-wtype="${wt}"]`);
        animCls = "anim-w-" + wt.toLowerCase().replace(/\s+/g, "-");
      } else if (lb.extra || lb.wide || lb.noBall) {
        const ex = lb.extra || (lb.wide ? "wide" : "noball");
        btn = pad.querySelector(`.extra-pill[data-extra="${ex}"][data-declared="${lb.declared ? 1 : 0}"]`);
        animCls = "anim-ex-" + ex;
      } else {
        btn = pad.querySelector(`.run-btn[data-runs="${lb.runs || 0}"]`);
        animCls = "anim-r" + (lb.runs || 0);
      }
      if (btn) {
        if (!reduced) btn.classList.add(animCls);
        // Ball fly happens AFTER renderAll rebuilt the pad — click-time spawn would be wiped
        const r = lb.wicket ? 0 : (lb.extra || lb.wide || lb.noBall ? -1 : (lb.runs || 0));
        const variant = lb.wicket ? "" : r === 0 ? "dot" : r === 4 ? "four" : r === 6 ? "six" : "";
        const count = lb.wicket || r === -1 ? 1 : r === 0 ? 1 : (r === 2 || r === 3 || r === 5 ? r : 1);
        flyBall(btn, variant, count);
        if (!reduced) setTimeout(() => btn.classList.remove(animCls), 1300);
      }
    }
  }

  function batsmanOptions(innObj, excludeOut = true) {
    const squad = squadNames(innObj.batting);
    const active = [innObj.striker, innObj.nonStriker].filter(Boolean);
    const out = excludeOut ? (innObj.out || []) : [];
    return squad.filter(n => !active.includes(n) && !out.includes(n));
  }
  function nameOptions(innObj, current, exclude = "") {
    const squad = squadNames(innObj.batting);
    const out = innObj.out || [];
    return squad.filter(n => (!out.includes(n) || n === current) && n !== exclude);
  }
  function bowlerOptions(innObj) {
    return squadNames(innObj.bowling);
  }

  function renderScorecard() {
    const result = matchResult(m);
    const motm = manOfTheMatch(m);
    let html = `
      ${result ? `<div class="result-banner">${esc(result)}</div>` : ""}
      ${motm ? `<div class="motm-line">🏆 Man of the Match — <b>${esc(motm.name)}</b> <span class="motm-why">(${esc(motm.why)})</span></div>` : ""}
      <div class="match-header">
        <div class="match-teams">${esc(m.team1)} <span class="vs">vs</span> ${esc(m.team2)}</div>
        <div class="item-sub">${esc(m.date || "—")} · ${esc(m.venue || "—")} · ${m.overs || 20} overs${m.tournament ? ` · 🏆 ${esc(m.tournament)}` : ""} · <span class="badge match-status ${m.status}">${m.status}</span></div>
        ${m.toss ? `<div class="item-sub">🏏 Toss: ${esc(m.toss.winner)} won, chose to ${m.toss.decision === "bat" ? "bat" : "field"} first</div>` : ""}
      </div>`;
    const cards = (m.innings || []).map((innObj, idx) => ({ innObj, idx, super: false }));
    if (m.superOver && m.superOver.innings) m.superOver.innings.forEach((innObj, idx) => cards.push({ innObj, idx, super: true }));
    cards.forEach(({ innObj, idx, super: isSuper }) => {
      const curIdx = isSuper ? (m.superOver.current || 0) : m.currentInnings;
      const firstInn = isSuper ? m.superOver.innings[0] : m.innings[0];
      const s = inningsScore(innObj);
      const done = inningsDone(m, innObj, idx, firstInn);
      const legalN = (innObj.balls || []).filter(isLegalBall).length;
      const rrTxt = legalN ? ((s.runs / legalN) * 6).toFixed(2) : "0.00";
      const firstInnDone = isSuper
        ? (m.superOver.current > 0 || inningsDone(m, firstInn, 0, firstInn))
        : (m.currentInnings > 0 || inningsDone(m, firstInn, 0, firstInn));
      const tgt = idx === 1 && firstInnDone ? inningsScore(firstInn).runs + 1 : null;
      const ex = extrasBreakdown(innObj);
      const exTxt = [["Wide", ex.wide], ["NoBall", ex.noball], ["Byes", ex.bye], ["LegByes", ex.legbye], ["Wide+Bye", ex.widebye]]
        .filter(([, v]) => v[0] > 0)
        .map(([lbl, v]) => `${lbl} ${v[0]}${v[1] ? ` (${v[1]} decl)` : ""}`)
        .join(" · ");
      html += `${isSuper && idx === 0 ? `<div class="super-over-divider"><span class="super-over-divider-line"></span><span class="super-over-divider-text">🏏 SUPER OVER</span><span class="super-over-divider-line"></span></div>` : ""}
      <div class="innings-card">
        <div class="innings-head pad-score-head">
          <div class="pad-score-main">
            <span class="pad-team">${esc(innObj.batting)} batting</span>
            <span class="pad-bigscore">${s.runs}<span class="pad-bigscore-wkts">/${s.wkts}</span></span>
            <span class="pad-overs">(${s.overs} ov)</span>
          </div>
          <div class="pad-chips">
            ${isSuper ? '<span class="badge">SUPER OVER</span>' : ""}
            ${done || idx < curIdx ? '<span class="badge">Done</span>' : '<span class="badge live">Innings ' + (idx + 1) + '</span>'}
            <span class="item-sub">Bowling: ${esc(innObj.bowling)}</span>
            <span class="pad-chip">RR ${rrTxt}</span>
            ${tgt ? `<span class="pad-target-big">🎯 Target ${tgt}</span>` : ""}
            ${exTxt ? `<span class="pad-chip pad-chip-extras">Extras: ${esc(exTxt)}</span>` : ""}
          </div>
        </div>`;
      // Batsmen — pre-registered players show 0/0 before their first ball
      const batMap = {};
      (innObj.batters || []).forEach(n => { batMap[n] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: (innObj.out || []).includes(n), retired: (innObj.retired || []).includes(n) }; });
      // Safety: striker/non-striker must always appear (covers matches where a
      // wicket replacement was never registered before this fix)
      [innObj.striker, innObj.nonStriker].forEach(n => {
        if (n && !batMap[n]) batMap[n] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: (innObj.out || []).includes(n), retired: (innObj.retired || []).includes(n) };
      });
      (innObj.balls || []).forEach(b => {
        if (b.extra && !b.noBall) return; // non-NoBall extras go to team, not any player
        if (!batMap[b.batter]) batMap[b.batter] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: (innObj.out || []).includes(b.batter), retired: (innObj.retired || []).includes(b.batter) };
        const r = b.runs || 0;
        batMap[b.batter].runs += r; // No Ball + N runs are credited to the batter
        if (r === 4) batMap[b.batter].fours++;
        if (r === 6) batMap[b.batter].sixes++;
        if (isLegalBall(b)) batMap[b.batter].balls++;
      });
      // Dismissal info per out batsman — the Nth dismissed name lines up with the
      // Nth wicket ball (out[] and wicket balls are recorded in the same order);
      // shows how they got out plus the bowler whose over it was.
      const wktBalls = (innObj.balls || []).filter(b => b.wicket);
      const dismissals = {};
      (innObj.out || []).forEach((nm, i) => {
        const b = wktBalls[i];
        if (!b) return;
        const t = b.wicketType || "out";
        dismissals[nm] = t.charAt(0).toUpperCase() + t.slice(1) + (b.bowler ? ` · b ${b.bowler}` : "");
      });
      // Batting card on top, Bowling card below (stacked)
      const batRows = Object.entries(batMap).map(([name, st]) => {
        const atCrease = !isAdmin && (name === innObj.striker || name === innObj.nonStriker);
        const label = `${atCrease ? "*" : ""}${capBadge(name, innObj.batting)}${esc(name)}`;
        const howOut = st.out && dismissals[name] ? `<span class="how-out">${esc(dismissals[name])}</span>` : "";
        return `<tr><td>${label}${st.out ? " †" : st.retired ? " <span class='retired-tag'>RH</span>" : ""}${howOut}</td><td>${st.runs}</td><td>${st.balls}</td><td>${st.fours}</td><td>${st.sixes}</td><td>${st.balls ? ((st.runs / st.balls) * 100).toFixed(1) : "0.0"}</td></tr>`;
      }).join("");
      // Bowlers — pre-registered bowlers show 0/0 before their first over
      const bowlMap = {};
      (innObj.bowlers || []).forEach(n => { bowlMap[n] = { runs: 0, balls: 0, wkts: 0 }; });
      (innObj.balls || []).forEach(b => {
        if (b.extra) return; // extras are team figures, not bowler's
        if (!bowlMap[b.bowler]) bowlMap[b.bowler] = { runs: 0, balls: 0, wkts: 0 };
        bowlMap[b.bowler].runs += (b.runs || 0) + (b.wide ? 1 : 0) + (b.noBall ? 1 : 0);
        if (isLegalBall(b)) bowlMap[b.bowler].balls++;
        if (b.wicket) bowlMap[b.bowler].wkts++;
      });
      const bowlRows = Object.entries(bowlMap).map(([name, st]) => {
        const o = Math.floor(st.balls / 6), bb = st.balls % 6;
        const econ = st.balls ? (st.runs / (st.balls / 6)).toFixed(2) : "0.00";
        return `<tr><td>${capBadge(name, innObj.bowling)}${esc(name)}</td><td>${o}.${bb}</td><td>${st.runs}</td><td>${st.wkts}</td><td>${econ}</td></tr>`;
      }).join("");
      // Over-by-over — single pass: legal balls advance the over, extras join current
      const overs = {};
      let legalSoFar = 0;
      (innObj.balls || []).forEach(b => {
        const o = Math.floor(legalSoFar / 6);
        if (!overs[o]) overs[o] = [];
        overs[o].push(b);
        if (isLegalBall(b)) legalSoFar++;
      });
      const overKeys = Object.keys(overs).sort((a, b) => a - b);
      const lastBallObj = (innObj.balls || [])[innObj.balls.length - 1];
      const overCards = overKeys.map(o => {
        const cells = overs[o].map(b => {
          let cls = "ball", txt;
          if (b === lastBallObj) cls += " ball-pop";
          if (b.wicket) { cls += " wicket"; txt = "W"; }
          else if (b.extra) {
            const lbl = { wide: "wd", noball: "nb", bye: "b", legbye: "lb", widebye: "wd+b" }[b.extra] || "ex";
            if (b.extra === "bye" || b.extra === "legbye") {
              // Legal extras — show runs scored (b, b2, b4…)
              const r = b.runs || 1;
              txt = lbl + (r > 1 ? r : "");
              cls += r === 4 ? " b4" : r === 6 ? " b6" : " ex-" + b.extra;
            } else if (b.extra === "noball") {
              // No Ball + N — show the runs the batter scored off it
              txt = lbl + (b.declared ? "+2" : (b.runs ? "+" + b.runs : ""));
              cls += " ex-noball";
            } else {
              txt = lbl + (b.declared ? "+2" : "");
              cls += " ex-" + b.extra;
            }
          }
          else if (b.wide) { cls += " wide"; txt = `wd${b.runs ? "+" + b.runs : ""}`; }
          else if (b.noBall) { cls += " noball"; txt = `nb${b.runs ? "+" + b.runs : ""}`; }
          else { txt = b.runs; if (b.runs === 4) cls += " b4"; else if (b.runs === 6) cls += " b6"; }
          return `<span class="${cls}">${txt}</span>`;
        }).join("");
        const isCurrent = o === overKeys[overKeys.length - 1] && !done && idx === curIdx;
        return `<div class="over-row${isCurrent ? " over-current" : ""}"><span class="over-num">Over ${Number(o) + 1}</span>${cells}</div>`;
      }).join("");
      html += `
        <div class="innings-tables">
          <div class="innings-table-card">
            <div class="innings-table-title">Batting — ${esc(innObj.batting)}</div>
            <table class="score-table"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>${batRows || `<tr><td colspan="6">—</td></tr>`}</tbody></table>
          </div>
          <div class="innings-table-card">
            <div class="innings-table-title">Bowling — ${esc(innObj.bowling)}</div>
            <table class="score-table"><thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>${bowlRows || `<tr><td colspan="5">—</td></tr>`}</tbody></table>
          </div>
        </div>
        ${overCards ? `<div class="overs-log">${overCards}</div>` : ""}
        <div class="innings-entry" id="${isSuper ? "so" : "inn"}-entry-${idx}"></div>
      </div>`;
    });
    // Super Over button — shown when match is tied and no decided super over yet
    const tied = m.status === "completed" && m.innings.length >= 2 &&
      inningsScore(m.innings[0]).runs === inningsScore(m.innings[1]).runs;
    const soDecided = m.superOver && m.superOver.innings && m.superOver.innings.length === 2 &&
      inningsDone(m, m.superOver.innings[0], 0, m.superOver.innings[0]) &&
      inningsDone(m, m.superOver.innings[1], 1, m.superOver.innings[0]) &&
      inningsScore(m.superOver.innings[0]).runs !== inningsScore(m.superOver.innings[1]).runs;
    if (isAdmin && tied && !soDecided) {
      html += `<div class="pad super-over-pad"><button id="btn-super-over" class="btn btn-primary">🏏 ${m.superOver ? "Super Over tied — Play again" : "Play Super Over"}</button></div>`;
    }
    // Preserve the live scoring pads across this rebuild. innerHTML would
    // destroy the buttons, the open wicket panel and any in-flight ball
    // animation — re-attach the very same nodes into the fresh slots.
    const keepPads = new Map();
    scorecardEl.querySelectorAll(".innings-entry").forEach(el => { if (el.id) keepPads.set(el.id, el); });
    scorecardEl.innerHTML = html;
    if (keepPads.size) {
      scorecardEl.querySelectorAll(".innings-entry").forEach(slot => {
        const old = slot.id && keepPads.get(slot.id);
        if (old) slot.replaceWith(old);
      });
    }
  }

  // Scoring pad rendered inside EACH innings card — active only for the
  // current innings; future innings show a lock until their turn.
  function renderEntry() {
    const soDone = m.superOver && m.superOver.innings &&
      inningsDone(m, m.superOver.innings[0], 0, m.superOver.innings[0]) &&
      inningsDone(m, m.superOver.innings[1], 1, m.superOver.innings[0]);
    const groups = [];
    if (m.status === "live") groups.push({ arr: m.innings, cur: m.currentInnings, isSuper: false, prefix: "inn" });
    if (m.superOver && m.superOver.innings && !soDone) groups.push({ arr: m.superOver.innings, cur: m.superOver.current || 0, isSuper: true, prefix: "so" });
    // Match completed → wipe any stale pads so the "Complete Match" button disappears
    if (m.status === "completed") {
      scorecardEl.querySelectorAll(".innings-entry").forEach(el => { el.innerHTML = ""; el.dataset.sig = ""; });
    }
    groups.forEach(g => {
    for (let idx = 0; idx < g.arr.length; idx++) {
      const box = document.getElementById(`${g.prefix}-entry-${idx}`);
      if (!box) continue;
      if (!isAdmin) { box.innerHTML = ""; continue; }
      const innObj = g.arr[idx];
      if (idx > g.cur) {
        box.innerHTML = `<div class="innings-locked">🔒 Yet to bat — opens after previous innings completes</div>`;
        continue;
      }
      if (idx < g.cur) { box.innerHTML = ""; continue; }
      const firstInn = g.isSuper ? g.arr[0] : m.innings[0];
      const done = inningsDone(m, innObj, idx, firstInn);
      const s = inningsScore(innObj);
      const target = idx === 1 ? inningsScore(firstInn).runs + 1 : null;
      const P = g.isSuper ? `-so${idx}` : `-${idx}`; // id suffix keeps pads unique per innings
      // Over boundary: after every 6 legal balls a NEW bowler must bowl
      const legalBalls = (innObj.balls || []).filter(isLegalBall).length;
      const atOverStart = legalBalls > 0 && legalBalls % 6 === 0;
      const prevBowler = atOverStart
        ? [...(innObj.balls || [])].reverse().find(isLegalBall)?.bowler
        : null;
      // Bowling quota: only ONE bowler may bowl 2 overs (12 legal balls);
      // every other bowler is capped at 1 over (6 legal balls) once that slot is taken
      const bowlCount = {};
      (innObj.balls || []).forEach(b => { if (isLegalBall(b) && b.bowler) bowlCount[b.bowler] = (bowlCount[b.bowler] || 0) + 1; });
      const twoOverTaken = Object.values(bowlCount).some(c => c >= 12);
      const bowlOpts = bowlerOptions(innObj).filter(n => {
        const c = bowlCount[n] || 0;
        if (c >= 12) return false;            // already bowled 2 overs
        if (c >= 6 && twoOverTaken) return false; // has 1 over but 2-over slot is gone
        return true;
      });
      // All out = no available new batsman (not out, not at crease, not yet batted, not retired)
      const retiredNames = innObj.retired || [];
      const newBatsmanOpts = batsmanOptions(innObj).filter(n => !retiredNames.includes(n));
      const allOut = newBatsmanOpts.length === 0;
      // Striker/Non-striker lock once both are on the scorecard — change only via wicket
      const battersReg = innObj.batters || [];
      const strikeLocked = !!(innObj.striker && innObj.nonStriker && battersReg.includes(innObj.striker) && battersReg.includes(innObj.nonStriker));
      const bowlSelect = atOverStart
        ? `<option value="" ${innObj.bowler ? "" : "selected"}>— New bowler (over ${legalBalls / 6 + 1}) —</option>` +
          bowlOpts.filter(n => n !== prevBowler).map(n => `<option ${n === innObj.bowler ? "selected" : ""}>${esc(n)}</option>`).join("")
        : bowlOpts.map(n => `<option ${n === innObj.bowler ? "selected" : ""}>${esc(n)}</option>`).join("");
      // Once both batsmen are on the scorecard, dropdowns show ONLY the current pair
      const strikerOpts = strikeLocked ? [innObj.striker] : nameOptions(innObj, innObj.striker, innObj.nonStriker);
      const nonStrikerOpts = strikeLocked ? [innObj.nonStriker] : nameOptions(innObj, innObj.nonStriker, innObj.striker);
      // Add button: visible at innings start OR when an active batter isn't registered yet
      const unregistered = [innObj.striker, innObj.nonStriker].some(n => n && !(innObj.batters || []).includes(n));
      const showAddBtn = (innObj.balls || []).length === 0 || unregistered;
      // Retired hurt: active player + replacement
      const retired = innObj.retired || [];
      const rhOptions = [innObj.striker, innObj.nonStriker].filter(Boolean);
      const rhNewOpts = batsmanOptions(innObj).filter(n => !retired.includes(n));
      // Structure signature — the pad is rebuilt ONLY when its structure
      // changes (players / bowler options / over boundary / wicket limits).
      // A plain ball must never rebuild the button area.
      const structSig = [
        g.isSuper ? "so" : "inn", idx, isAdmin ? "a" : "v",
        innObj.batting, innObj.bowling, innObj.striker, innObj.nonStriker, innObj.bowler,
        legalBalls, bowlOpts.join(">"), showAddBtn ? 1 : 0, strikeLocked ? 1 : 0, allOut ? 1 : 0, done ? 1 : 0,
        (innObj.batters || []).join("|"), (innObj.out || []).join("|"), (innObj.retired || []).join("|"),
      ].join("~");
      if (box.dataset.sig === structSig) continue; // unchanged → keep the live buttons/handlers
      box.dataset.sig = structSig;
      box.innerHTML = `
      ${done ? `<div class="pad"><button id="end-innings${P}" class="btn btn-primary">${idx === 0 ? "End Innings → Start 2nd" : g.isSuper ? "Complete Super Over" : "Complete Match"}</button></div>` : `
      <div class="pad pad-players">
        <div class="strike-line">Striker <b>${esc(innObj.striker || "—")}</b> &nbsp;·&nbsp; Non-striker <b>${esc(innObj.nonStriker || "—")}</b></div>
        <label class="pad-label">Bowler<select id="e-bowler${P}" class="pad-select">${bowlSelect}</select></label>
        <label class="pad-label">Striker<select id="e-striker${P}" class="pad-select">${strikerOpts.map(n => `<option ${n === innObj.striker ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <button type="button" class="swap-btn" id="swap-strike${P}" title="Swap strike">⇄</button>
        <label class="pad-label">Non-striker<select id="e-nonstriker${P}" class="pad-select">${nonStrikerOpts.map(n => `<option ${n === innObj.nonStriker ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        ${showAddBtn ? `<button type="button" id="add-players${P}" class="btn btn-primary add-players-btn">+ Add to Scorecard</button>` : ""}
      </div>
      <div class="pad-grid">
      <div class="pad pad-runs">
        <div class="pad-label">Runs</div>
        <div class="run-pad">
          <button class="run-btn" data-runs="0">•<i class="btn-ball"></i></button>
          ${[1,2,3,4,5,6].map(r => `<button class="run-btn" data-runs="${r}">${r}<i class="btn-ball"></i></button>`).join("")}
        </div>
      </div>
      <div class="pad pad-wicket">
        <div class="pad-label">Wicket</div>
        <div class="wicket-pad">
          ${[["bowled","bowled"],["run out","runout"],["stumped","stumped"],["caught","caught"],["other","other"]].map(([t, k]) => `<button class="wicket-pill" data-wtype="${t}">${WICONS[k]}<span>${t}</span></button>`).join("")}
        </div>
      </div>
      <div class="pad wicket-details hidden" id="wicket-panel${P}">
        <div class="wd-chip" id="wicket-type-tag${P}"></div>
        <div class="wd-grid">
          <label class="pad-label">Out<select id="w-out${P}" class="pad-select"><option value="striker">${esc(innObj.striker || "Striker")}</option><option value="nonStriker">${esc(innObj.nonStriker || "Non-striker")}</option></select></label>
          ${!allOut ? `<label class="pad-label">New batsman<select id="w-new${P}" class="pad-select">${newBatsmanOpts.map(n => `<option>${esc(n)}</option>`).join("")}</select></label>` : `<div class="pad-label" style="color:var(--danger);font-weight:700;">All out: no new batsman</div>`}
          <div class="wd-runout hidden" id="wd-runout${P}">
            <label class="pad-label">Runs completed<input id="w-runs${P}" type="number" min="0" max="6" value="0" class="pad-input" /></label>
            <label class="pad-label">Ends<select id="w-ends${P}" class="pad-select">
              <option value="striker">Striker</option>
              <option value="nonStriker" selected>Non-striker</option>
            </select></label>
          </div>
        </div>
        <div class="wd-actions">
          <button id="w-cancel${P}" class="btn-outline">Cancel</button>
          <button id="w-confirm${P}" class="btn-solid-red">Confirm wicket</button>
        </div>
      </div>
      <div class="pad pad-extras">
        <div class="pad-label">Extras <span class="pad-label-sub">(+1 team run · declared +2)</span></div>
        <div class="extra-pad">
          <button class="extra-pill" data-extra="wide" data-declared="0">Wide<i class="btn-ball sm"></i></button>
          <button class="extra-pill extra-declared" data-extra="wide" data-declared="1">Wide + Declared<i class="btn-ball sm"></i><i class="decl-dot"></i></button>
          <button class="extra-pill extra-declared" data-extra="widebye" data-declared="0">Wide + Bye<i class="btn-ball sm"></i></button>
          <div class="extra-pill nb-pill" id="nb-pill${P}" data-extra="noball" data-declared="0" data-nbruns="0">
            <button type="button" class="nb-main" id="nb-main${P}">No Ball</button>
            <button type="button" class="nb-minus" id="nb-minus${P}" aria-label="Remove a run from the No Ball">−</button>
            <span class="nb-count" id="nb-count${P}">0</span>
            <button type="button" class="nb-plus" id="nb-plus${P}" aria-label="Add a run to the No Ball">+</button>
            <button type="button" class="nb-ok" id="nb-ok${P}" aria-label="Confirm No Ball">✓</button>
          </div>
          <button class="extra-pill extra-declared" data-extra="noball" data-declared="1">No Ball + Declared<i class="btn-ball sm"></i><i class="decl-dot"></i></button>
          <button class="extra-pill" data-extra="bye" data-declared="0">Bye<i class="btn-ball sm"></i></button>
          <button class="extra-pill extra-declared" data-extra="bye" data-declared="1">Bye + Declared<i class="btn-ball sm"></i><i class="decl-dot"></i></button>
          <button class="extra-pill" data-extra="legbye" data-declared="0">Leg Bye<i class="btn-ball sm"></i></button>
          <button class="extra-pill extra-declared" data-extra="legbye" data-declared="1">Leg Bye + Declared<i class="btn-ball sm"></i><i class="decl-dot"></i></button>
        </div>
        <div class="pad-label rh-label">Retired Hurt <span class="pad-label-sub">(not out — can return)</span></div>
        <div class="rh-row">
          <select id="rh-player${P}" class="pad-select">${rhOptions.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>
          <select id="rh-new${P}" class="pad-select">${rhNewOpts.map(n => `<option>${esc(n)}</option>`).join("")}</select>
          <button type="button" id="rh-confirm${P}" class="btn-solid-red rh-confirm">Confirm</button>
        </div>
        ${retired.length ? `<div class="rh-list">Retired: ${retired.map(esc).join(", ")}</div>` : ""}
      </div>
      </div>`}`;

      // Restore wicket panel if a re-render wiped it mid-entry
      const ws = wicketUI[P];
      if (ws && ws.open) {
        box.querySelectorAll(".wicket-pill").forEach(p => p.classList.toggle("selected", p.dataset.wtype === ws.type));
        const tag = box.querySelector(`#wicket-type-tag${P}`);
        if (tag) tag.textContent = `${ws.type} · credited to ${innObj.bowler || "bowler"}`;
        box.querySelector(`#wd-runout${P}`)?.classList.toggle("hidden", !(ws.type === "run out" || ws.type === "other"));
        box.querySelector(`#wicket-panel${P}`)?.classList.remove("hidden");
        const wo = box.querySelector(`#w-out${P}`); if (wo && ws.out) wo.value = ws.out;
        const wn = box.querySelector(`#w-new${P}`); if (wn && ws.newName) wn.value = ws.newName;
        const wr = box.querySelector(`#w-runs${P}`); if (wr && ws.runs != null) wr.value = ws.runs;
        const we = box.querySelector(`#w-ends${P}`); if (we && ws.ends) we.value = ws.ends;
      }
      // All pad interactions are handled by the single delegated listener on
      // #scorecard (onScorecardClick/Change/Input) — never re-bound per render.
    }
    });
  }

  /* ---------- Scoring pad: ONE delegated listener set on #scorecard ----------
     Buttons are no longer bound one-by-one on every render, so re-rendering
     can never drop a handler or swallow a click (button replaced between
     mousedown and mouseup). */
  let lastScEl = null, lastScTs = 0;
  function dupClick(el) {
    // Short 150ms lock on the SAME control: guards against a click being
    // recorded twice (e.g. a duplicate/double-fired event), while never
    // dropping a press on a DIFFERENT button.
    const now = Date.now();
    if (el && el === lastScEl && now - lastScTs < 150) return true;
    lastScEl = el; lastScTs = now;
    return false;
  }
  function padCtx(el) {
    if (!el || !el.closest) return null;
    const entry = el.closest(".innings-entry");
    if (!entry || !entry.id) return null;
    const hit = entry.id.match(/^(inn|so)-entry-(\d+)$/);
    if (!hit) return null;
    const isSuper = hit[1] === "so";
    const idx = Number(hit[2]);
    return { super: isSuper, idx, entry, P: isSuper ? `-so${idx}` : `-${idx}` };
  }
  function padInnings(cur) {
    m = findMatch(matchId);
    if (!m) return null;
    if (cur.super) return (m.superOver && m.superOver.innings && m.superOver.innings[cur.idx]) || null;
    return m.innings[cur.idx] || null;
  }
  function rememberWicketField(t, P) {
    const ws = wicketUI[P] = wicketUI[P] || {};
    if (t.id === `w-out${P}`) { ws.out = t.value; return true; }
    if (t.id === `w-new${P}`) { ws.newName = t.value; return true; }
    if (t.id === `w-ends${P}`) { ws.ends = t.value; return true; }
    if (t.id === `w-runs${P}`) { ws.runs = Number(t.value) || 0; return true; }
    return false;
  }
  function openWicketPanel(cur, box, type) {
    const innObj = padInnings(cur); if (!innObj) return;
    const ws = wicketUI[cur.P] = wicketUI[cur.P] || {};
    ws.type = type; ws.open = true;
    box.querySelectorAll(".wicket-pill").forEach(p => p.classList.toggle("selected", p.dataset.wtype === type));
    const tag = box.querySelector(`#wicket-type-tag${cur.P}`);
    if (tag) tag.textContent = `${type} · credited to ${innObj.bowler || "bowler"}`;
    box.querySelector(`#wd-runout${cur.P}`)?.classList.toggle("hidden", !(type === "run out" || type === "other"));
    const panel = box.querySelector(`#wicket-panel${cur.P}`);
    if (panel) {
      panel.classList.remove("hidden");
      // Pull the Out / New batsman / Confirm card into view automatically
      requestAnimationFrame(() => panel.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  }
  function closeWicketPanel(cur, box) {
    if (wicketUI[cur.P]) wicketUI[cur.P].open = false;
    box.querySelector(`#wicket-panel${cur.P}`)?.classList.add("hidden");
    box.querySelectorAll(".wicket-pill").forEach(p => p.classList.remove("selected"));
  }
  function endInnings(cur) {
    m = findMatch(matchId); if (!m) return;
    const seed = inn => {
      const bs = squadNames(inn.batting), bw = squadNames(inn.bowling);
      inn.striker = bs[0] || ""; inn.nonStriker = bs[1] || ""; inn.bowler = bw[0] || "";
    };
    if (cur.super) {
      if (m.superOver && cur.idx === 0) { m.superOver.current = 1; seed(m.superOver.innings[1]); }
    } else if (cur.idx === 0) {
      m.currentInnings = 1;
      seed(m.innings[1]);
    } else {
      m.status = "completed";
    }
    saveDB(db);
    renderAll();
  }
  function confirmWicket(cur, box) {
    const P = cur.P;
    const innObj = padInnings(cur);
    if (!innObj) return;
    const ws = wicketUI[P];
    if (!ws || !ws.open || !ws.type) return;
    if (!innObj.bowler) { showToast("Set bowler first"); return; }
    // Mirror addBall's legality guards BEFORE mutating so a rejected wicket
    // can never half-apply (ball pushed but batsman not dismissed, or vice-versa).
    const legalBalls = (innObj.balls || []).filter(isLegalBall).length;
    if (legalBalls > 0 && legalBalls % 6 === 0) {
      const prevBowler = [...(innObj.balls || [])].reverse().find(isLegalBall)?.bowler;
      if (innObj.bowler === prevBowler) { showToast("Over finished — select a new bowler"); return; }
    }
    const bc = {};
    (innObj.balls || []).forEach(b => { if (isLegalBall(b) && b.bowler) bc[b.bowler] = (bc[b.bowler] || 0) + 1; });
    const bowled = bc[innObj.bowler] || 0;
    const twoOverTaken = Object.values(bc).some(c => c >= 12);
    if (bowled >= 12 || (bowled >= 6 && twoOverTaken)) { showToast("Bowling quota reached for this innings"); return; }
    const outSel = box.querySelector(`#w-out${P}`)?.value || "striker";
    const outName = outSel === "nonStriker" ? innObj.nonStriker : innObj.striker;
    if (!outName) { showToast("No batsman to dismiss"); return; }
    const newName = box.querySelector(`#w-new${P}`)?.value || "";
    let runs = 0, ends = "nonStriker";
    if (ws.type === "run out" || ws.type === "other") {
      runs = Number(box.querySelector(`#w-runs${P}`)?.value || 0) || 0;
      ends = box.querySelector(`#w-ends${P}`)?.value || "nonStriker";
    }
    const facedBy = innObj.striker;
    snapshotInnings(innObj, { super: cur.super, idx: cur.idx }); // wickets snapshot before out/replacement mutation
    innObj.out = innObj.out || [];
    innObj.out.push(outName);
    let striker = innObj.striker, nonStriker = innObj.nonStriker;
    if (ws.type === "run out" || ws.type === "other") {
      if (runs % 2 === 1) { const tmp = striker; striker = nonStriker; nonStriker = tmp; }
      if (ends === "striker") striker = newName || striker; else nonStriker = newName || nonStriker;
    } else if (outSel === "nonStriker") {
      nonStriker = newName || nonStriker;
    } else {
      striker = newName || striker;
    }
    innObj.striker = striker; innObj.nonStriker = nonStriker;
    if (newName) { innObj.batters = innObj.batters || []; if (!innObj.batters.includes(newName)) innObj.batters.push(newName); }
    ws.open = false;
    addBall({ super: cur.super, idx: cur.idx }, { batter: facedBy, bowler: innObj.bowler, wicket: true, wicketType: ws.type, runs });
  }
  function onScorecardClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#btn-super-over")) { startSuperOver(); return; }
    const cur = padCtx(t);
    if (!cur) return;
    const innObj = padInnings(cur);
    if (!innObj) return;
    const box = cur.entry, P = cur.P;
    if (t.closest(`#end-innings${P}`)) { endInnings(cur); return; }
    const runBtn = t.closest(".run-btn");
    if (runBtn) {
      if (dupClick(runBtn)) return;
      addBall({ super: cur.super, idx: cur.idx }, { batter: innObj.striker, bowler: innObj.bowler, runs: Number(runBtn.dataset.runs) });
      return;
    }
    // No Ball "+" / "−" stepper — tap "No Ball" to arm, + / − to adjust runs, ✓ to record
    const nbMinus = t.closest(".nb-minus");
    if (nbMinus) {
      const pill = nbMinus.closest(".nb-pill");
      const next = Math.max(0, (Number(pill.dataset.nbruns) || 0) - 1);
      pill.dataset.nbruns = String(next);
      const c = pill.querySelector(".nb-count"); if (c) c.textContent = String(next);
      pill.classList.add("armed");
      return;
    }
    const nbPlus = t.closest(".nb-plus");
    if (nbPlus) {
      const pill = nbPlus.closest(".nb-pill");
      const next = Math.min(6, (Number(pill.dataset.nbruns) || 0) + 1);
      pill.dataset.nbruns = String(next);
      const c = pill.querySelector(".nb-count"); if (c) c.textContent = String(next);
      pill.classList.add("armed");
      return;
    }
    if (t.closest(".nb-main")) { t.closest(".nb-pill").classList.add("armed"); return; }
    if (t.closest(".nb-ok")) {
      const pill = t.closest(".nb-pill");
      if (dupClick(pill)) return;
      const runs = Number(pill.dataset.nbruns) || 0;
      pill.dataset.nbruns = "0";
      const c = pill.querySelector(".nb-count"); if (c) c.textContent = "0";
      pill.classList.remove("armed");
      addBall({ super: cur.super, idx: cur.idx }, { batter: innObj.striker, bowler: innObj.bowler, extra: "noball", noBall: true, runs });
      return;
    }
    const exBtn = t.closest(".extra-pill");
    if (exBtn) {
      if (dupClick(exBtn)) return;
      const ex = exBtn.dataset.extra, declared = exBtn.dataset.declared === "1";
      const ball = { batter: innObj.striker, bowler: innObj.bowler, extra: ex, declared };
      if (ex === "wide") { ball.wide = true; ball.runs = declared ? 1 : 0; }        // +1 wide (declared → +2 team runs)
      else if (ex === "widebye") { ball.wide = true; ball.runs = 1; }               // wide + 1 bye = 2 team runs (illegal ball)
      else if (ex === "noball") { ball.noBall = true; ball.runs = declared ? 1 : 0; }
      else { ball.runs = declared ? 2 : 1; }                                        // bye / leg bye (legal)
      addBall({ super: cur.super, idx: cur.idx }, ball);
      return;
    }
    const wPill = t.closest(".wicket-pill");
    if (wPill) { openWicketPanel(cur, box, wPill.dataset.wtype); return; }
    if (t.closest(`#w-confirm${P}`)) { if (dupClick(t.closest(`#w-confirm${P}`))) return; confirmWicket(cur, box); return; }
    if (t.closest(`#w-cancel${P}`)) { closeWicketPanel(cur, box); return; }
    if (t.closest(`#swap-strike${P}`)) {
      const a = innObj.striker; innObj.striker = innObj.nonStriker; innObj.nonStriker = a;
      saveDB(db); renderAll(); return;
    }
    if (t.closest(`#add-players${P}`)) {
      innObj.batters = innObj.batters || [];
      [innObj.striker, innObj.nonStriker].forEach(n => { if (n && !innObj.batters.includes(n)) innObj.batters.push(n); });
      innObj.bowlers = innObj.bowlers || [];
      if (innObj.bowler && !innObj.bowlers.includes(innObj.bowler)) innObj.bowlers.push(innObj.bowler);
      saveDB(db); renderAll(); return;
    }
    if (t.closest(`#rh-confirm${P}`)) {
      const player = box.querySelector(`#rh-player${P}`)?.value;
      if (!player) return;
      const repl = box.querySelector(`#rh-new${P}`)?.value || "";
      innObj.retired = innObj.retired || [];
      if (!innObj.retired.includes(player)) innObj.retired.push(player);
      if (innObj.striker === player) innObj.striker = repl;
      else if (innObj.nonStriker === player) innObj.nonStriker = repl;
      if (repl) { innObj.batters = innObj.batters || []; if (!innObj.batters.includes(repl)) innObj.batters.push(repl); }
      saveDB(db); renderAll(); return;
    }
  }
  function onScorecardChange(e) {
    const t = e.target;
    const cur = padCtx(t);
    if (!cur) return;
    if (rememberWicketField(t, cur.P)) return; // wicket-panel fields live in wicketUI, no re-render
    const innObj = padInnings(cur);
    if (!innObj) return;
    if (t.id === `e-bowler${cur.P}`) innObj.bowler = t.value;
    else if (t.id === `e-striker${cur.P}`) innObj.striker = t.value;
    else if (t.id === `e-nonstriker${cur.P}`) innObj.nonStriker = t.value;
    else return;
    saveDB(db); renderAll();
  }
  function onScorecardInput(e) {
    const cur = padCtx(e.target);
    if (!cur) return;
    rememberWicketField(e.target, cur.P);
  }

  function snapshotInnings(innObj, cur) {
    m.ballHistory = m.ballHistory || [];
    m.ballHistory.push({
      idx: cur.idx, super: !!cur.super, striker: innObj.striker, nonStriker: innObj.nonStriker,
      bowler: innObj.bowler, out: [...(innObj.out || [])], balls: innObj.balls.length,
    });
    if (m.ballHistory.length > 200) m.ballHistory.shift();
  }

  function addBall(cur, ball) {
    m = findMatch(matchId); if (!m) return;
    const innObj = cur.super ? (m.superOver && m.superOver.innings && m.superOver.innings[cur.idx]) : m.innings[cur.idx];
    if (!innObj) return;
    if ((!ball.batter && !ball.extra) || !ball.bowler) { showToast(ball.extra ? "Set bowler first" : "Set striker & bowler first"); return; }
    // Over rule: a new over (every 6 legal balls) needs a different bowler
    const legalBalls = (innObj.balls || []).filter(isLegalBall).length;
    if (legalBalls > 0 && legalBalls % 6 === 0) {
      const prevBowler = [...(innObj.balls || [])].reverse().find(isLegalBall)?.bowler;
      if (ball.bowler === prevBowler) { showToast("Over finished — select a new bowler"); return; }
    }
    // Bowling quota: one bowler max 2 overs; others max 1 once that slot is taken
    const bc = {};
    (innObj.balls || []).forEach(b => { if (isLegalBall(b) && b.bowler) bc[b.bowler] = (bc[b.bowler] || 0) + 1; });
    const bowled = bc[ball.bowler] || 0;
    const twoOverTaken = Object.values(bc).some(c => c >= 12);
    if (bowled >= 12 || (bowled >= 6 && twoOverTaken)) { showToast("Bowling quota reached for this innings"); return; }
    if (!ball.wicket) snapshotInnings(innObj, cur); // wickets snapshot earlier (before out/replacement mutation)
    innObj.balls.push(ball);
    // Last-ball marker for live animation sync (viewers replay once via ts)
    m.lastBall = {
      runs: ball.runs || 0, wicket: !!ball.wicket, wicketType: ball.wicketType || "",
      extra: ball.extra || "", wide: !!ball.wide, noBall: !!ball.noBall,
      declared: !!ball.declared, extraRuns: ball.extraRuns || 0, ts: Date.now(),
    };
    // Strike rotation — driven by the runs credited to the delivery
    // (batter runs, byes / leg-byes and No-Ball + N all count; a plain Wide or
    // plain No Ball contributes 0):
    //   • odd runs  → swap striker / non-striker (1, 3, 5 …)
    //   • even runs → no swap               (2, 4, 6 …)
    //   • LAST delivery of an over (LEGAL balls only) is inverted — odd keeps
    //     strike, even swaps.
    // This reproduces every requested case automatically:
    //   Wide 0 → no swap · Wide+Declared 1 → swap · Wide+Bye 1 → swap
    //   NoBall+N → parity of N · NoBall+Declared 1 → swap
    //   Bye/LegBye 1 → swap · Bye+Declared/LegBye+Declared 2 → no swap
    const legalCount = innObj.balls.filter(isLegalBall).length;
    const isLastBallOfOver = isLegalBall(ball) && legalCount % 6 === 0;
    if (!ball.wicket) {
      const odd = (ball.runs || 0) % 2 === 1;
      const shouldSwap = isLastBallOfOver ? !odd : odd;
      if (shouldSwap) {
        const t = innObj.striker; innObj.striker = innObj.nonStriker; innObj.nonStriker = t;
      }
    }
    saveDB(db);
    renderAll();
  }

  function undoBall() {
    m = findMatch(matchId); if (!m) return;
    m.ballHistory = m.ballHistory || [];
    const h = m.ballHistory.pop();
    if (!h) { showToast("Nothing to undo"); return; }
    const innObj = h.super && m.superOver ? m.superOver.innings[h.idx] : m.innings[h.idx];
    if (!innObj) { showToast("Nothing to undo"); return; }
    innObj.striker = h.striker; innObj.nonStriker = h.nonStriker;
    innObj.bowler = h.bowler; innObj.out = h.out;
    innObj.balls.length = h.balls;
    if (h.super && m.superOver) m.superOver.current = h.idx; else m.currentInnings = h.idx;
    saveDB(db);
    renderAll();
    showToast("Undone");
  }

  function startSuperOver() {
    m = findMatch(matchId); if (!m) return;
    // Super over: team that batted FIRST in the match bowls FIRST → they bat SECOND in SO
    const bat1 = m.innings[1].batting, bat2 = m.innings[0].batting;
    const soInn = t => ({ batting: t, bowling: t === bat1 ? bat2 : bat1, balls: [], striker: "", nonStriker: "", bowler: "", out: [], batters: [], bowlers: [], retired: [], super: true });
    m.superOver = { innings: [soInn(bat1), soInn(bat2)], current: 0 };
    const i1 = m.superOver.innings[0];
    const batSquad = squadNames(i1.batting), bowlSquad = squadNames(i1.bowling);
    i1.striker = batSquad[0] || ""; i1.nonStriker = batSquad[1] || ""; i1.bowler = bowlSquad[0] || "";
    saveDB(db); renderAll();
    showToast("Super Over started — 1 over each, max 2 wickets");
  }

  function resetMatch() {
    m = findMatch(matchId); if (!m) return;
    if (!confirm("Reset this match? All score data will be erased and it returns to Upcoming.")) return;
    m.status = "upcoming";
    delete m.toss;
    delete m.superOver;
    m.currentInnings = 0;
    m.ballHistory = [];
    m.innings[0].batting = m.team1; m.innings[0].bowling = m.team2;
    m.innings[1].batting = m.team2; m.innings[1].bowling = m.team1;
    m.innings.forEach(i => { i.balls = []; i.out = []; i.striker = ""; i.nonStriker = ""; i.bowler = ""; i.batters = []; i.bowlers = []; i.retired = []; });
    saveDB(db);
    renderAll();
    showToast("Match reset");
  }

  function renderAll() {
    m = findMatch(matchId);           // re-resolve after remote sync replaces db.matches
    if (!m || !Array.isArray(m.innings) || m.innings.length < 2) {
      scorecardEl.innerHTML = `<div class="empty-state">No match selected or match data is incomplete. <a href="matches.html">Back to Matches</a></div>`;
      return;
    }
    // One-time fix: super over batting order must be reversed vs main match innings
    if (m.superOver && m.superOver.innings && m.superOver.innings.length === 2 &&
        m.innings.length >= 2 && m.superOver.innings[0].batting === m.innings[0].batting) {
      m.superOver.innings.reverse();
      saveDB(db);
    }
    renderScorecard(); renderEntry(); renderTossPanel();
    // Admin: once the 10th league match completes (or a playoff completes) create/fill
    // the Qualifier → Semi-final → Final chain. Idempotent; persists via saveDB only on change.
    syncPlayoffs();
    // Play ball animation once per new delivery (ts-guarded; no replay on load)
    if (!stagePrimed) { stagePrimed = true; lastBallTs = (m.lastBall && m.lastBall.ts) || 0; }
    if (m.lastBall && m.lastBall.ts && m.lastBall.ts > lastBallTs) {
      lastBallTs = m.lastBall.ts;
      animateDeliveryUI(m.lastBall);
    }
  }
  window.__renderMatch = renderAll;

  // Reset / Undo controls (admin only)
  const controlsEl = document.getElementById("match-controls");
  if (controlsEl && isAdmin) {
    controlsEl.classList.remove("hidden");
    controlsEl.innerHTML = `
      <button id="btn-undo" class="btn btn-cancel">↩ Undo</button>
      <button id="btn-reset" class="btn btn-danger">Reset Match</button>`;
    controlsEl.querySelector("#btn-undo").addEventListener("click", undoBall);
    controlsEl.querySelector("#btn-reset").addEventListener("click", resetMatch);
  }

  // Toss panel (admin, upcoming only) — rendered at top, removed once live
  function renderTossPanel() {
    document.querySelector(".toss-panel")?.remove();
    if (!isAdmin || m.status !== "upcoming") return;
    const tossEl = document.createElement("div");
    tossEl.className = "toss-panel";
    tossEl.innerHTML = `
      <div class="pad-label">🏏 Toss</div>
      <div class="toss-grid">
        <label class="pad-label">Toss winner<select id="toss-winner" class="pad-select">
          <option value="${esc(m.team1)}">${esc(m.team1)}</option>
          <option value="${esc(m.team2)}">${esc(m.team2)}</option>
        </select></label>
        <label class="pad-label">Decision<select id="toss-decision" class="pad-select">
          <option value="bat">Bat first</option>
          <option value="field">Field first</option>
        </select></label>
      </div>
      <button id="start-match" class="btn btn-live">▶ Start Match</button>`;
    scorecardEl.insertAdjacentElement("beforebegin", tossEl);
    tossEl.querySelector("#start-match").addEventListener("click", () => {
      const winner = tossEl.querySelector("#toss-winner").value;
      const decision = tossEl.querySelector("#toss-decision").value;
      const other = winner === m.team1 ? m.team2 : m.team1;
      const batFirst = decision === "bat" ? winner : other;
      const bowlFirst = batFirst === m.team1 ? m.team2 : m.team1;
      m.toss = { winner, decision };
      m.innings[0].batting = batFirst; m.innings[0].bowling = bowlFirst;
      m.innings[1].batting = bowlFirst; m.innings[1].bowling = batFirst;
      m.status = "live";
      const i1 = m.innings[0];
      const batSquad = squadNames(i1.batting);
      const bowlSquad = squadNames(i1.bowling);
      i1.striker = batSquad[0] || ""; i1.nonStriker = batSquad[1] || ""; i1.bowler = bowlSquad[0] || "";
      saveDB(db);
      renderAll();
    });
  }

  // ONE delegated listener set — attached exactly once, so re-rendering the
  // pad never loses a click and no button is ever bound twice.
  scorecardEl.addEventListener("click", onScorecardClick);
  scorecardEl.addEventListener("change", onScorecardChange);
  scorecardEl.addEventListener("input", onScorecardInput);

  renderAll();
})();

/* ---------- Live sync: viewers/owners see updates without refresh ---------- */
let lastRemoteJSON = "";
function applyRemoteData(data) {
  if (!data || typeof data !== "object") return;
  // Ignore the realtime echo of THIS device's own writes — local is the source
  // of truth while scoring; applying our own (older) snapshot would revert the
  // ball just recorded.
  if (data._client && data._client === CLIENT_ID) return;
  // Stale guard: a remote snapshot older than our last local save must not
  // overwrite newer local balls (last-write-wins by updatedAt).
  if ((data._ts || 0) && (db._ts || 0) > (data._ts || 0)) return;
  const j = JSON.stringify(data);
  if (j === lastRemoteJSON) return;          // skip identical payloads (no flicker)
  lastRemoteJSON = j;
  if (data._ts) db._ts = Math.max(db._ts || 0, data._ts);
  const tomb = new Set(mergeTombstones(db.deletedMatches, data.deletedMatches));
  Object.keys(data).forEach(k => {
    if (k === "_ts" || k === "_client") return; // write metadata — handled above
    if (k === "matches") db.matches = mergeMatches(db.matches, data.matches, tomb);
    else if (k === "deletedMatches") db.deletedMatches = [...tomb];
    else if (k in db) db[k] = data[k];
  });
  window.__renderMatch?.();
  window.__renderMatches?.();
  window.__renderStandings?.();
}
function startLiveSync() {
  if (sbClient) {
    sbClient
      .channel("app_state_global")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "app_state" },
        payload => applyRemoteData(payload.new?.data))
      .subscribe();
  } else {
    // localStorage fallback — same-browser tabs / no Supabase
    setInterval(() => {
      try { applyRemoteData(JSON.parse(localStorage.getItem(DB_KEY))); } catch {}
    }, 1500);
    window.addEventListener("storage", () => {
      try { applyRemoteData(JSON.parse(localStorage.getItem(DB_KEY))); } catch {}
    });
  }
}

/* ---------- Init ---------- */
// Notes are private to each owner (keyed by login email)
const myNotes = n => n.owner === (session.email || session.name);

// One-time event wiring — runs exactly once per page load (re-binding would
// duplicate handlers and inject extra floating "+" buttons).
function bindStaticUI() {
  // Hide owner-only nav links for non-owners
  document.querySelectorAll('a[href="my-tournament.html"], a[href="my-auction.html"], a[href="my-team.html"], a[href="notes.html"]')
    .forEach(a => { if (session.role !== "owner") a.style.display = "none"; });

  bindDetailSection("tournament", "tournament", ["name", "ground", "datetime"]);
  bindDetailSection("auction", "auction", ["name", "datetime", "tournament"]);
  bindDetailSection("my-tournament", "myTournament", ["team", "captain", "budget"]);
  bindDetailSection("my-auction", "myAuction", ["team", "purse", "status"]);
  bindListSection("teams", ["name", "owner", "email", "tournament", "auction", "budget", "purse", "status", "iconPlayer"], teamItem);
  bindListSection("players", ["name", "role", "basePrice", "team", "iconFor", "captainFor"], playerItem);
  bindListSection("links", ["title", "url"], linkItem);
  bindListSection("notes", ["text"], noteItem, myNotes);
}

// Paint every data-driven part of the page from the current in-memory db.
// Safe to call repeatedly: once instantly from localStorage, then again after
// the shared (remote) snapshot has been merged in.
function paintUI() {
  // Populate association dropdowns from existing data
  fillSelect(q('#teams-form select[name="tournament"]'), db.tournament.name ? [db.tournament.name] : []);
  fillSelect(q('#teams-form select[name="auction"]'),    db.auction.name    ? [db.auction.name]    : []);
  fillSelect(q('#auction-form select[name="tournament"]'), db.tournament.name ? [db.tournament.name] : []);
  fillSelect(q('#players-form select[name="team"]'),     db.teams.map(t => t.name));
  refreshPlayerRoleSelects(null);

  window.__renderMatches?.();
  window.__renderMatch?.();
  window.__renderStandings?.();

// If an owner is logged in, their My Tournament / My Auction pages
// auto-populate from the team whose Email Id matches their login email.
const ownerTeam = session.role === "owner"
  ? db.teams.find(t =>
      (t.email || "").trim().toLowerCase() === (session.email || "").toLowerCase())
  : null;

const myTournView = ownerTeam
  ? { team: ownerTeam.name, captain: ownerTeam.owner, budget: ownerTeam.budget || 0,
      tournament: ownerTeam.tournament, auction: ownerTeam.auction }
  : db.myTournament;
const myAuctView = ownerTeam
  ? { team: ownerTeam.name, purse: ownerTeam.purse || 0,
      status: ownerTeam.status || "Registered",
      tournament: ownerTeam.tournament, auction: ownerTeam.auction }
  : db.myAuction;

// My Team page — owner's squad in purchase order, with icon + owner name
const myTeamHeader = document.getElementById("my-team-header");
const myTeamPlayersEl = document.getElementById("my-team-players");
const myTeamCount = document.getElementById("my-team-count");
if (myTeamHeader) {
  if (ownerTeam) {
    const idx = db.teams.indexOf(ownerTeam);
    const letter = idx >= 0 ? String.fromCharCode(65 + idx) : "?";
    const captainName = ownerTeam.owner || session.name || session.email || "Owner";
    const roleRank = p => p.captainFor === ownerTeam.name ? 0
      : p.iconFor === ownerTeam.name ? 1 : 2;
    const squad = getTeamSquad(ownerTeam.name)
      .sort((a, b) => roleRank(a) - roleRank(b));
    const purseLeft = Math.max(0, (ownerTeam.purse || ownerTeam.budget || 0) - teamSoldSum(db, ownerTeam));
    const subs = [`Owner / Captain: ${esc(captainName)}`];
    if (ownerTeam.iconPlayer) subs.push(`Icon: ${esc(ownerTeam.iconPlayer)}`);
    if (ownerTeam.tournament) subs.push(`🏆 ${esc(ownerTeam.tournament)}`);
    if (ownerTeam.auction) subs.push(`🔨 ${esc(ownerTeam.auction)}`);
    subs.push(`Purse left ₹${purseLeft.toLocaleString("en-IN")}`);
    subs.push(`Squad: ${squad.length}`);
    const logoSm = ownerTeam.logo ? `<img class="team-logo-sm" src="${ownerTeam.logo}" alt="${esc(ownerTeam.name)} logo" />` : "";
    myTeamHeader.innerHTML = `
      <div class="item">
        <div class="item-main">
          <div class="item-title">${logoSm}${esc(ownerTeam.name)}</div>
          <div class="item-sub">${subs.join(" · ")}</div>
        </div>
      </div>`;
    myTeamCount.textContent = `₹${purseLeft.toLocaleString("en-IN")} left · ${squad.length} player${squad.length === 1 ? "" : "s"}`;
    myTeamPlayersEl.innerHTML = squad.length
      ? squad.map((p, i) => {
          const el = playerItem(p);
          el.querySelector(".item-actions")?.remove();
          el.insertAdjacentHTML("afterbegin", `<span class="player-num">${i + 1}</span>`);
          return el.outerHTML;
        }).join("")
      : `<p class="item-sub" style="padding:14px 4px">No players bought yet — they will appear here after the auction.</p>`;
  } else {
    myTeamHeader.innerHTML = `<p class="item-sub" style="padding:14px 4px">No team is linked to your login email yet. Ask the admin to set your Email Id on your team.</p>`;
    myTeamCount.textContent = "";
    myTeamPlayersEl.innerHTML = "";
  }
}

renderDetails("tournament", "tournament", db.tournament);
renderDetails("auction", "auction", db.auction);
const liveNameEl = document.getElementById("live-auction-name");
if (liveNameEl) liveNameEl.textContent = db.auction.name || "Live Auction";
renderDetails("my-tournament", "myTournament", myTournView);
renderDetails("my-auction", "myAuction", myAuctView);
const myAuctRemaining = document.getElementById("my-auction-remaining");
if (myAuctRemaining) {
  myAuctRemaining.textContent = ownerTeam
    ? `₹${Math.max(0, (ownerTeam.purse || ownerTeam.budget || 0) - teamSoldSum(db, ownerTeam)).toLocaleString("en-IN")}`
    : "—";
}
renderList("teams", teamItem);
renderList("players", playerItem);
renderList("links", linkItem);
renderList("notes", noteItem, myNotes);

applyPermissions();
refreshAuctionLiveUI();

document.getElementById("year")?.replaceChildren(new Date().getFullYear());
}

async function boot() {
  // 1) Paint instantly from localStorage — no network round-trip needed.
  bindStaticUI();
  paintUI();

  // 2) Then sync the shared (Supabase) snapshot and repaint with fresh data.
  await initRemoteDB();
  normalizePlayerTeams();
  startLiveSync();
  initViewerStage();
  paintUI();

  // Admin landing mid-auction → open the live stage once on page load
  if (db.auction.live && session.role === "admin") openAuctionStage();
}

boot();
