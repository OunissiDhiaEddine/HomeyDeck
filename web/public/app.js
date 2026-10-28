// HomeyDeck PWA. Talks to the API on the same origin with the app key, which
// is kept in this device's localStorage and nowhere else.

const POLL_MS = 4000;
const KEY_STORAGE = "homeydeck.appKey";

const PHASES = {
  unknown: { title: "Checking…", busy: true },
  online: { title: "Online" },
  offline: { title: "Asleep or off" },
  waking: { title: "Waking up…", busy: true },
  sleeping: { title: "Going to sleep…", busy: true },
  restarting: { title: "Restarting…", busy: true },
  setup: { title: "Not set up yet" },
};

const $ = (id) => document.getElementById(id);
const state = { status: null, updatedAt: null, busy: false, launchingSteam: false, timer: null };

// --- storage -----------------------------------------------------------------

function appKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function saveKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    showError("This browser won't let HomeyDeck save the key.");
  }
}

// --- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${appKey()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(navigator.onLine ? "Can't reach the server." : "You're offline.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ApiError("The app key was rejected. Check it in Settings.", 401);
  if (!res.ok || data.ok === false) throw new ApiError(friendly(data.error) || `The server answered ${res.status}.`, res.status);
  return data;
}

function friendly(error) {
  if (!error) return "";
  return error.charAt(0).toUpperCase() + error.slice(1) + (error.endsWith(".") ? "" : ".");
}

// --- status loop -------------------------------------------------------------

async function refresh() {
  if (!appKey()) return render();
  try {
    state.status = await api("/api/status");
    state.updatedAt = Date.now();
    if (state.status.steamRunning || !state.status.online) state.launchingSteam = false;
  } catch (err) {
    if (err.status === 401) state.status = null;
    showError(err.message);
  }
  render();
}

function startPolling() {
  stopPolling();
  refresh();
  state.timer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

document.addEventListener("visibilitychange", () => (document.hidden ? stopPolling() : startPolling()));

// --- actions -----------------------------------------------------------------

async function run(label, fn) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await fn();
  } catch (err) {
    showError(`${label}: ${err.message}`);
  } finally {
    state.busy = false;
    await refresh();
  }
}

$("wake").addEventListener("click", () => run("Wake", () => api("/api/wake", {})));

$("sleep").addEventListener("click", () =>
  confirmAction("Put the PC to sleep?", "You can wake it again from here.", "Sleep", false, () =>
    run("Sleep", () => api("/api/command", { action: "sleep" })),
  ),
);

$("restart").addEventListener("click", () =>
  confirmAction("Restart the PC?", "Anything unsaved on the PC will be lost.", "Restart", true, () =>
    run("Restart", () => api("/api/command", { action: "reboot" })),
  ),
);

function launchSteam() {
  state.launchingSteam = true;
  run("Launch Steam", () => api("/api/command", { action: "launch_steam" })).catch(() => {});
}

// --- rendering ---------------------------------------------------------------

function phase() {
  if (!appKey()) return "setup";
  return state.status?.phase ?? "unknown";
}

function render() {
  const p = phase();
  const s = state.status;
  const online = p === "online";
  const info = PHASES[p] ?? PHASES.unknown;

  document.body.dataset.phase = p;
  document.body.classList.toggle("transitioning", Boolean(info.busy) || state.busy);
  $("hostname").textContent = s?.hostname || "My PC";
  $("phase-title").textContent = info.title;
  $("detail").textContent = detail(p, s);
  $("setup-card").hidden = Boolean(appKey());

  $("wake").disabled = state.busy || !["offline", "unknown", "sleeping"].includes(p) || !appKey();
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
    const btn = el("button", "pill");
    btn.textContent = "Launch";
    btn.disabled = state.busy;
    btn.addEventListener("click", launchSteam);
    slot.replaceChildren(btn);
  } else {
    slot.replaceChildren();
  }

  $("updated").textContent = state.updatedAt ? `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
}

function detail(p, s) {
  if (p === "setup") return "Add your app key in Settings";
  if (!s) return "";
  if (p === "online" && s.uptimeSeconds != null) return `Up for ${formatDuration(s.uptimeSeconds)}`;
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

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// --- toast, confirm and settings ---------------------------------------------

let toastTimer;
function showError(message) {
  $("toast-text").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}
$("toast-close").addEventListener("click", () => ($("toast").hidden = true));

let onConfirm = null;
function confirmAction(title, text, verb, danger, action) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  const yes = $("confirm-yes");
  yes.textContent = verb;
  yes.className = `sheet-btn ${danger ? "danger" : "primary"}`;
  onConfirm = action;
  $("confirm").hidden = false;
}
$("confirm-yes").addEventListener("click", () => {
  $("confirm").hidden = true;
  onConfirm?.();
});
$("confirm-no").addEventListener("click", () => ($("confirm").hidden = true));

function openSettings() {
  $("app-key").value = appKey();
  $("setup-code-status").textContent = "";
  $("settings").hidden = false;
}
$("open-settings").addEventListener("click", openSettings);
$("setup-open").addEventListener("click", openSettings);
$("settings-cancel").addEventListener("click", () => ($("settings").hidden = true));
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveKey($("app-key").value.trim());
  $("settings").hidden = true;
  state.status = null;
  startPolling();
});

// "Set up this PC": copies a code that the agent reads from the clipboard
// when it's double-clicked, so installing needs no terminal.
$("copy-setup").addEventListener("click", async () => {
  const status = $("setup-code-status");
  const key = $("app-key").value.trim() || appKey();
  if (!key) {
    status.textContent = "Add the app key first.";
    return;
  }
  saveKey(key);
  try {
    const { code } = await api("/api/setup");
    await navigator.clipboard.writeText(code);
    status.textContent = "Copied. Now double-click homeydeck-agent.exe on this PC.";
  } catch (err) {
    status.textContent = err.message || "Couldn't copy the setup code.";
  }
});

for (const sheet of [$("confirm"), $("settings")]) {
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) sheet.hidden = true;
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

render();
startPolling();
