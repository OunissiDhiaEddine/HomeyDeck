// HomeyDeck PWA. Talks to the API on the same origin. Signing in sets an
// HttpOnly session cookie, so the app itself never holds a secret.

const FAST_POLL_MS = 4000; // while someone is using the app
const SLOW_POLL_MS = 30000; // when it's open but nobody has touched it for a while
const WATCH_FOR_MS = 90000; // how long after the last touch the PC is asked to poll fast
const PAIR_CHECK_MS = 4000;
const PC_STORAGE = "homeydeck.pc";

const PHASES = {
  unknown: { title: "Checking…", busy: true },
  online: { title: "Online" },
  offline: { title: "Asleep or off" },
  waking: { title: "Waking up…", busy: true },
  sleeping: { title: "Going to sleep…", busy: true },
  restarting: { title: "Restarting…", busy: true },
  none: { title: "No PC yet" },
};

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  pcs: [],
  maxPcs: null,
  agentUrl: "",
  pc: null, // the selected PC's id
  status: null,
  updatedAt: null,
  busy: false,
  launchingSteam: false,
  timer: null,
  lastTouch: Date.now(),
};

// --- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(navigator.onLine ? "Can't reach the server." : "You're offline.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new ApiError(friendly(data.error) || `The server answered ${res.status}.`, res.status, data.code);
    if (data.code === "signed_out" || data.code === "disabled") signedOut(err.message);
    throw err;
  }
  return data;
}

function friendly(error) {
  if (!error) return "";
  return error.charAt(0).toUpperCase() + error.slice(1) + (/[.!?]$/.test(error) ? "" : ".");
}

// --- session -----------------------------------------------------------------

async function loadSession() {
  try {
    const data = await api("/api/session");
    state.user = data.user;
    state.pcs = data.pcs;
    state.maxPcs = data.maxPcs;
    state.agentUrl = data.agentUrl;
    let saved = null;
    try {
      saved = localStorage.getItem(PC_STORAGE);
    } catch {}
    if (!state.pcs.some((p) => p.id === state.pc)) state.pc = state.pcs.find((p) => p.id === saved)?.id ?? state.pcs[0]?.id ?? null;
    showView("deck");
    renderPicker();
    if (state.user.mustChange) openPassword(true);
    startPolling();
    return true;
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) {
      showView("deck");
      showError(err.message);
    }
    return false;
  }
}

function signedOut(message) {
  stopPolling();
  state.user = null;
  state.pcs = [];
  state.status = null;
  closeAllSheets();
  showView("auth");
  if (message && !/sign in/i.test(message)) $("login-error").textContent = message;
}

function showView(view) {
  document.body.dataset.view = view;
  $("auth").hidden = view !== "auth";
  $("deck").hidden = view !== "deck";
  if (view === "auth") checkServer();
}

function selectPc(id) {
  state.pc = id;
  state.status = null;
  state.updatedAt = null;
  state.launchingSteam = false;
  try {
    localStorage.setItem(PC_STORAGE, id ?? "");
  } catch {}
  renderPicker();
  startPolling();
}

// --- sign in and sign up -----------------------------------------------------

$("show-signup").addEventListener("click", () => {
  $("login-form").hidden = true;
  $("signup-form").hidden = false;
  $("signup-invite").focus();
});
$("show-login").addEventListener("click", () => {
  $("signup-form").hidden = true;
  $("login-form").hidden = false;
});

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth($("login-error"), e.submitter, { action: "login", username: $("login-name").value.trim(), password: $("login-password").value });
});

$("signup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth($("signup-error"), e.submitter, {
    action: "signup",
    invite: $("signup-invite").value,
    username: $("signup-name").value.trim(),
    password: $("signup-password").value,
  });
});

async function submitAuth(errorEl, button, body) {
  errorEl.textContent = "";
  if (button) button.disabled = true;
  try {
    await api("/api/session", body);
    $("login-password").value = "";
    $("signup-password").value = "";
    await loadSession();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    if (button) button.disabled = false;
  }
}

// On the sign-in page, tell whoever deployed this what's still missing.
async function checkServer() {
  let health;
  try {
    health = await (await fetch("/api/health", { cache: "no-store" })).json();
  } catch {
    return;
  }
  const missing = [];
  if (!health.database) missing.push("Connect an Upstash Redis database in Vercel → Storage.");
  if (!health.dataKey) missing.push("Add a DATA_KEY environment variable (one is below).");
  if (!health.admin) missing.push("Add ADMIN_USERNAME and ADMIN_PASSWORD environment variables, then sign in with them.");
  $("server-setup").hidden = missing.length === 0;
  $("server-setup-list").replaceChildren(...missing.map((m) => el("li", "", m)));
  $("data-key-box").hidden = health.dataKey;
  if (!health.dataKey && !$("data-key").textContent) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    $("data-key").textContent = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}
$("copy-data-key").addEventListener("click", () => copy($("data-key").textContent, $("copy-data-key")));

// --- status loop -------------------------------------------------------------

const watching = () => Date.now() - state.lastTouch < WATCH_FOR_MS;

async function refresh() {
  if (!state.user) return;
  if (!state.pc) return render();
  const pc = state.pc;
  try {
    const status = await api(`/api/status?pc=${encodeURIComponent(pc)}&watch=${watching() ? 1 : 0}`);
    if (pc !== state.pc) return;
    state.status = status;
    state.updatedAt = Date.now();
    if (status.steamRunning || !status.online) state.launchingSteam = false;
  } catch (err) {
    if (err.code === "pc_removed") {
      state.pc = null;
      await loadSession();
      return;
    }
    if (err.status !== 401 && err.status !== 403) showError(err.message);
  }
  render();
}

// Polls quickly while someone is using the app, slowly once they stop, and
// not at all while it's hidden.
function schedule() {
  clearTimeout(state.timer);
  if (document.hidden || !state.user) return;
  state.timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, watching() ? FAST_POLL_MS : SLOW_POLL_MS);
}

function startPolling() {
  refresh().then(schedule);
}

function stopPolling() {
  clearTimeout(state.timer);
  state.timer = null;
}

function touched() {
  const wasIdle = !watching();
  state.lastTouch = Date.now();
  if (wasIdle && state.user && !document.hidden) startPolling();
}

for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, touched, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return stopPolling();
  state.lastTouch = Date.now();
  if (state.user) startPolling();
});

// --- actions -----------------------------------------------------------------

async function run(label, fn) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const result = await fn();
    if (result?.pending) showError(`${label}: sent. The PC will pick it up within a minute.`, "info");
  } catch (err) {
    showError(`${label}: ${err.message}`);
  } finally {
    state.busy = false;
    await refresh();
  }
}

const command = (action) => api("/api/command", { pc: state.pc, action });

$("wake").addEventListener("click", () => run("Wake", () => command("wake")));

$("sleep").addEventListener("click", () =>
  confirmAction({ title: "Put the PC to sleep?", text: "You can wake it again from here.", verb: "Sleep", action: () => run("Sleep", () => command("sleep")) }),
);

$("restart").addEventListener("click", () =>
  confirmAction({ title: "Restart the PC?", text: "Anything unsaved on the PC will be lost.", verb: "Restart", danger: true, action: () => run("Restart", () => command("reboot")) }),
);

function launchSteam() {
  state.launchingSteam = true;
  run("Launch Steam", () => command("launch_steam"));
}

$("empty-add").addEventListener("click", () => openPcForm(null));

// --- rendering ---------------------------------------------------------------

function currentPc() {
  return state.pcs.find((p) => p.id === state.pc) ?? null;
}

function phase() {
  if (!state.pc) return "none";
  return state.status?.phase ?? "unknown";
}

function renderPicker() {
  const picker = $("pc-picker");
  picker.hidden = state.pcs.length < 2;
  picker.replaceChildren(...state.pcs.map((p) => Object.assign(document.createElement("option"), { value: p.id, textContent: p.name, selected: p.id === state.pc })));
  render();
}
$("pc-picker").addEventListener("change", (e) => selectPc(e.target.value));

function render() {
  const p = phase();
  const s = state.status;
  const pc = currentPc();
  const online = p === "online";
  const info = PHASES[p] ?? PHASES.unknown;

  document.body.dataset.phase = p;
  document.body.classList.toggle("transitioning", Boolean(info.busy) || state.busy);
  $("hostname").textContent = pc?.name || s?.hostname || "My PC";
  $("phase-title").textContent = info.title;
  $("detail").textContent = detail(p, s, pc);
  $("empty-card").hidden = Boolean(state.pc);

  $("wake").disabled = state.busy || !pc?.wake || !["offline", "unknown", "sleeping"].includes(p);
  $("sleep").disabled = state.busy || !online;
  $("restart").disabled = state.busy || !online;

  const running = online && s.steamRunning;
  $("steam-subtitle").textContent = !online
    ? "Available when the PC is on"
    : running
      ? "Running, ready for Remote Play"
      : state.launchingSteam
        ? "Starting…"
        : "Not running";
  const slot = $("steam-action");
  if (state.launchingSteam && !running && online) {
    slot.replaceChildren(el("div", "spinner"));
  } else if (running) {
    const check = el("span", "check");
    check.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-label="Running"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm4.3 6.3-5.6 5.6-2.9-2.9-1.4 1.4 4.3 4.3 7-7-1.4-1.4Z"/></svg>';
    slot.replaceChildren(check);
  } else if (online) {
    const btn = el("button", "pill", "Launch");
    btn.disabled = state.busy;
    btn.addEventListener("click", launchSteam);
    slot.replaceChildren(btn);
  } else {
    slot.replaceChildren();
  }

  $("updated").textContent = state.updatedAt ? `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
}

function detail(p, s, pc) {
  if (p === "none") return "Add a PC to get started";
  if (!s) return "";
  if (p === "online" && s.uptimeSeconds != null) return `Up for ${formatDuration(s.uptimeSeconds)}`;
  if (p === "offline" && !pc?.wake) return "Add its MAC address and DDNS name in the menu to wake it";
  if (p === "offline" && s.lastSeen) return `Last seen ${relative(new Date(s.lastSeen))}`;
  if (p === "offline") return "The agent hasn't checked in yet";
  return "";
}

function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

function relative(date) {
  const mins = Math.round((Date.now() - date) / 60000);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (mins < 60) return fmt.format(-mins, "minute");
  if (mins < 1440) return fmt.format(-Math.round(mins / 60), "hour");
  return fmt.format(-Math.round(mins / 1440), "day");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateText(ms) {
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

// --- toast, sheets, confirm --------------------------------------------------

let toastTimer;
function showError(message, kind = "error") {
  $("toast-text").textContent = message;
  $("toast").dataset.kind = kind;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}
$("toast-close").addEventListener("click", () => ($("toast").hidden = true));

const SHEETS = ["confirm", "menu", "pc-sheet", "pair-sheet", "password-sheet", "admin-sheet"];
const sheetClosers = {};

function openSheet(id, onClose) {
  $(id).hidden = false;
  sheetClosers[id] = onClose;
}

function closeSheet(id) {
  if ($(id).hidden) return;
  if (id === "password-sheet" && state.user?.mustChange) return; // must pick a password first
  $(id).hidden = true;
  const onClose = sheetClosers[id];
  delete sheetClosers[id];
  onClose?.();
}

function closeAllSheets() {
  for (const id of SHEETS) {
    $(id).hidden = true;
    sheetClosers[id]?.();
    delete sheetClosers[id];
  }
}

for (const id of SHEETS) {
  const sheet = $(id);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) closeSheet(id);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = [...SHEETS].reverse().find((id) => !$(id).hidden);
  if (open) closeSheet(open);
});

let onConfirm = null;
function confirmAction({ title, text, verb, danger = false, password = false, action }) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  const yes = $("confirm-yes");
  yes.textContent = verb;
  yes.className = `sheet-btn ${danger ? "danger" : "primary"}`;
  $("confirm-password").hidden = !password;
  $("confirm-password").value = "";
  onConfirm = action;
  openSheet("confirm");
  if (password) $("confirm-password").focus();
}
$("confirm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const pw = $("confirm-password").value;
  closeSheet("confirm");
  onConfirm?.(pw);
});

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    }
    return true;
  } catch {
    showError("Couldn't copy. Select the text and copy it yourself.");
    return false;
  }
}

// --- menu --------------------------------------------------------------------

$("open-menu").addEventListener("click", openMenu);

function openMenu() {
  $("menu-user").textContent = `Signed in as ${state.user.name}${state.user.role === "admin" ? " (admin)" : ""}`;
  $("menu-admin").hidden = state.user.role !== "admin";
  const full = state.maxPcs != null && state.pcs.length >= state.maxPcs;
  $("menu-add").disabled = full;
  $("pc-limit").textContent = full ? `You've reached the limit of ${state.maxPcs} PCs. Remove one to add another.` : "";
  $("pc-rows").replaceChildren(
    ...(state.pcs.length ? state.pcs.map(pcRow) : [el("p", "hint", "No PCs yet.")]),
  );
  openSheet("menu");
}

function pcRow(pc) {
  const row = el("div", "row");
  const text = el("div", "row-text");
  text.append(el("strong", "", pc.name), el("span", "hint", pc.wake ? `Wake on port ${pc.port}` : "Wake not set up"));
  const edit = el("button", "pill quiet", "Settings");
  edit.addEventListener("click", () => {
    closeSheet("menu");
    openPcForm(pc);
  });
  row.append(text, edit);
  if (pc.id !== state.pc) {
    const show = el("button", "pill quiet", "Show");
    show.addEventListener("click", () => {
      closeSheet("menu");
      selectPc(pc.id);
    });
    row.append(show);
  }
  return row;
}

$("menu-add").addEventListener("click", () => {
  closeSheet("menu");
  openPcForm(null);
});
$("menu-password").addEventListener("click", () => {
  closeSheet("menu");
  openPassword(false);
});
$("menu-admin").addEventListener("click", () => {
  closeSheet("menu");
  openAdmin();
});
$("menu-logout").addEventListener("click", async () => {
  await api("/api/session", { action: "logout" }).catch(() => {});
  signedOut();
});
$("menu-logout-all").addEventListener("click", () =>
  confirmAction({
    title: "Sign out everywhere?",
    text: "Every phone and computer signed in to your account, including this one, will need to sign in again.",
    verb: "Sign out everywhere",
    action: async () => {
      await api("/api/account", { action: "logout_all" }).catch((err) => showError(err.message));
      signedOut();
    },
  }),
);
$("menu-delete").addEventListener("click", () =>
  confirmAction({
    title: "Delete your account?",
    text: "This removes your account and all your PCs for good. Enter your password to confirm.",
    verb: "Delete account",
    danger: true,
    password: true,
    action: async (password) => {
      try {
        await api("/api/account", { action: "delete", password });
        signedOut();
      } catch (err) {
        showError(err.message);
      }
    },
  }),
);

// --- add, edit and remove a PC -----------------------------------------------

let editing = null; // the PC being edited, or null when adding

async function openPcForm(pc) {
  editing = pc;
  $("pc-title").textContent = pc ? "PC settings" : "Add PC";
  $("pc-save").textContent = pc ? "Save" : "Next";
  $("pc-remove").hidden = !pc;
  $("pc-error").textContent = "";
  for (const id of ["pc-name", "pc-mac", "pc-host", "pc-port"]) $(id).value = "";
  if (pc) {
    $("pc-name").value = pc.name;
    try {
      const d = await api("/api/pcs", { action: "details", pc: pc.id });
      $("pc-mac").value = d.mac;
      $("pc-host").value = d.host;
      $("pc-port").value = d.mac ? String(d.port) : "";
    } catch (err) {
      $("pc-error").textContent = err.message;
    }
  }
  openSheet("pc-sheet");
}

$("pc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pc-error").textContent = "";
  const fields = { name: $("pc-name").value.trim(), mac: $("pc-mac").value.trim(), host: $("pc-host").value.trim(), port: $("pc-port").value.trim() };
  $("pc-save").disabled = true;
  try {
    if (editing) {
      await api("/api/pcs", { action: "update", pc: editing.id, ...fields });
      closeSheet("pc-sheet");
      await loadSession();
    } else {
      const pairing = await api("/api/pcs", { action: "add", ...fields });
      closeSheet("pc-sheet");
      openPairing(pairing);
    }
  } catch (err) {
    $("pc-error").textContent = err.message;
  } finally {
    $("pc-save").disabled = false;
  }
});

$("pc-remove").addEventListener("click", () => {
  const pc = editing;
  closeSheet("pc-sheet");
  confirmAction({
    title: `Remove ${pc.name}?`,
    text: "HomeyDeck on that PC stops working and uninstalls itself the next time it checks in.",
    verb: "Remove",
    danger: true,
    action: async () => {
      try {
        await api("/api/pcs", { action: "remove", pc: pc.id });
        if (state.pc === pc.id) state.pc = null;
        await loadSession();
      } catch (err) {
        showError(err.message);
      }
    },
  });
});

// --- pairing -----------------------------------------------------------------

let pairTimer = null;

function openPairing({ code, text, expiresIn }) {
  const expires = Date.now() + expiresIn * 1000;
  const host = text.slice(text.indexOf(":") + 1, text.lastIndexOf("/"));
  $("pair-code").replaceChildren(el("strong", "", code), el("span", "hint center", `To type it on the PC instead, enter ${host}/${code}`));
  $("agent-link").href = state.agentUrl;
  $("copy-pair").onclick = () => copy(text, $("copy-pair"));
  const before = new Set(state.pcs.map((p) => p.id));

  const tick = async () => {
    const left = Math.round((expires - Date.now()) / 1000);
    if (left <= 0) {
      $("pair-status").textContent = "This code expired. Close this and add the PC again.";
      return;
    }
    $("pair-status").textContent = `Waiting for the PC… the code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.`;
    try {
      const { waiting } = await api("/api/pcs", { action: "pair_status", code });
      if (!waiting) {
        await loadSession();
        const added = state.pcs.find((p) => !before.has(p.id));
        if (added) selectPc(added.id);
        $("pair-status").textContent = "Paired! Your PC is ready.";
        setTimeout(() => closeSheet("pair-sheet"), 1500);
        return;
      }
    } catch {}
    pairTimer = setTimeout(tick, PAIR_CHECK_MS);
  };
  openSheet("pair-sheet", () => clearTimeout(pairTimer));
  tick();
}

// --- password ----------------------------------------------------------------

function openPassword(forced) {
  $("password-intro").hidden = !forced;
  $("password-current-wrap").hidden = forced;
  $("password-cancel").hidden = forced;
  $("password-username").value = state.user?.name ?? "";
  $("password-current").value = "";
  $("password-next").value = "";
  $("password-error").textContent = "";
  openSheet("password-sheet");
}

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("password-error").textContent = "";
  try {
    await api("/api/account", { action: "password", current: $("password-current").value, next: $("password-next").value });
    state.user.mustChange = false;
    closeSheet("password-sheet");
    showError("Password changed. Other devices were signed out.", "info");
  } catch (err) {
    $("password-error").textContent = err.message;
  }
});

// --- admin -------------------------------------------------------------------

async function openAdmin() {
  for (const id of ["invite-new", "invite-new-hint", "reset-new", "reset-hint"]) $(id).hidden = true;
  openSheet("admin-sheet");
  await loadAdmin();
}

async function loadAdmin() {
  let data;
  try {
    data = await api("/api/admin");
  } catch (err) {
    return showError(err.message);
  }
  $("admin-warning").hidden = !data.adminPasswordSet;

  const invites = data.invites.filter((i) => i.state !== "used" || Date.now() - i.usedAt < 30 * 86400_000);
  $("invite-rows").replaceChildren(...(invites.length ? invites.map(inviteRow) : [el("p", "hint", "No invites yet.")]));
  $("user-rows").replaceChildren(...data.users.map(userRow));
}

function inviteRow(inv) {
  const row = el("div", "row");
  const text = el("div", "row-text");
  const status =
    inv.state === "used" ? `Used by ${inv.usedBy}` : inv.state === "expired" ? "Expired" : inv.expires ? `Open until ${dateText(inv.expires)}` : "Open";
  text.append(el("strong", "mono", `${inv.hint}-…`), el("span", "hint", `${status} · made ${dateText(inv.created)}`));
  row.append(text);
  if (inv.state !== "used") {
    const revoke = el("button", "pill quiet", inv.state === "open" ? "Revoke" : "Clear");
    revoke.addEventListener("click", async () => {
      await api("/api/admin", { action: "invite_revoke", id: inv.id }).catch((err) => showError(err.message));
      loadAdmin();
    });
    row.append(revoke);
  }
  return row;
}

function userRow(u) {
  const row = el("div", "row");
  const text = el("div", "row-text");
  const bits = [u.role === "admin" ? "Admin" : "User", `${u.pcs} PC${u.pcs === 1 ? "" : "s"}`, `joined ${dateText(u.created)}`];
  if (u.disabled) bits.unshift("Disabled");
  text.append(el("strong", "", u.name), el("span", "hint", bits.join(" · ")));
  row.append(text);
  if (u.id === state.user.id) return row;

  const act = (label, title, textBody, verb, danger, body, after) => {
    const b = el("button", "pill quiet", label);
    b.addEventListener("click", () =>
      confirmAction({
        title,
        text: textBody,
        verb,
        danger,
        action: async () => {
          try {
            const res = await api("/api/admin", { ...body, user: u.id });
            after?.(res);
          } catch (err) {
            showError(err.message);
          }
          loadAdmin();
        },
      }),
    );
    return b;
  };
  row.append(
    act("Reset", `Reset ${u.name}'s password?`, "They're signed out everywhere and get a temporary password, which they must change when they sign in.", "Reset password", false, { action: "user_reset" }, (res) => {
      $("reset-code").textContent = res.password;
      $("reset-new").hidden = false;
      $("reset-hint").textContent = `Temporary password for ${u.name}. Send it to them; it's shown once.`;
      $("reset-hint").hidden = false;
    }),
    u.disabled
      ? act("Enable", `Enable ${u.name}?`, "They can sign in again.", "Enable", false, { action: "user_disable", disabled: false })
      : act("Disable", `Disable ${u.name}?`, "They're signed out and can't sign in until you enable them again. Their PCs stay paired.", "Disable", true, { action: "user_disable", disabled: true }),
    act("Delete", `Delete ${u.name}?`, "Their account and PCs are removed for good. Their agents uninstall themselves.", "Delete", true, { action: "user_delete" }),
  );
  return row;
}

$("invite-create").addEventListener("click", async () => {
  try {
    const { code } = await api("/api/admin", { action: "invite_create", days: Number($("invite-days").value) });
    $("invite-code").textContent = code;
    $("invite-new").hidden = false;
    $("invite-new-hint").hidden = false;
    loadAdmin();
  } catch (err) {
    showError(err.message);
  }
});
$("invite-copy").addEventListener("click", () => copy($("invite-code").textContent, $("invite-copy")));
$("reset-copy").addEventListener("click", () => copy($("reset-code").textContent, $("reset-copy")));

// --- start -------------------------------------------------------------------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

render();
loadSession().then((ok) => {
  if (!ok && document.body.dataset.view === "loading") showView("auth");
});
