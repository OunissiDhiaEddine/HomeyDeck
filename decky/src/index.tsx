// HomeyDeck for Decky Loader: the Quick Access panel. It mirrors the PWA's
// main screen (status orb, Steam and Sunshine cards, Wake / Sleep / Restart).
// All HTTP goes through main.py, which keeps the session cookie.

import { ConfirmModal, DialogButton, DropdownItem, Focusable, PanelSection, PanelSectionRow, TextField, showModal, staticClasses } from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// --- backend -----------------------------------------------------------------

type Result = { ok: boolean; error?: string; code?: string; status?: number; pending?: boolean };
type Pc = { id: string; name: string; wake: boolean; port: number };
type User = { id: string; name: string; role: string; mustChange: boolean };
type Session = Result & { user?: User; pcs?: Pc[] };
type Status = Result & {
  phase: "online" | "offline" | "waking" | "sleeping" | "restarting";
  online: boolean;
  steamRunning: boolean;
  sunshineRunning: boolean | null;
  hostname: string | null;
  os: string | null;
  uptimeSeconds: number | null;
  lastSeen: string | null;
};
type Config = { server: string; signedIn: boolean; pc: string };

const getConfig = callable<[], Config>("get_config");
const login = callable<[server: string, username: string, password: string], Session>("login");
const logout = callable<[], Result>("logout");
const getSession = callable<[], Session>("session");
const selectPc = callable<[pc: string], Result>("select_pc");
const getStatus = callable<[pc: string, watch: boolean], Status>("status");
const sendCommand = callable<[pc: string, action: string], Result>("command");

// --- look (the PWA's colours) ------------------------------------------------

const TINT: Record<string, string> = {
  online: "#4dd98c",
  waking: "#ffb847",
  restarting: "#ffb847",
  sleeping: "#8c8cff",
  offline: "#8c8c8c",
  unknown: "#8c8c8c",
  none: "#8c8c8c",
};
const PHASES: Record<string, { title: string; busy?: boolean }> = {
  unknown: { title: "Checking…", busy: true },
  online: { title: "Online" },
  offline: { title: "Asleep or off" },
  waking: { title: "Waking up…", busy: true },
  sleeping: { title: "Going to sleep…", busy: true },
  restarting: { title: "Restarting…", busy: true },
  none: { title: "No PC yet" },
};

const CSS = `
.hd-hero { text-align: center; padding: 4px 0 10px; }
.hd-orb { position: relative; width: 92px; height: 92px; margin: 0 auto 8px; display: grid; place-items: center; }
.hd-orb-glow { position: absolute; inset: 0; border-radius: 50%; background: var(--hd-tint); opacity: .3; filter: blur(18px); animation: hd-breathe 2.2s ease-in-out infinite alternate; transition: background .6s ease; }
.hd-dim .hd-orb-glow { opacity: .1; }
.hd-orb-ring { position: relative; width: 70px; height: 70px; border-radius: 50%; display: grid; place-items: center; color: var(--hd-tint); background: rgba(255,255,255,.06); border: 1.5px solid var(--hd-tint-soft); transition: color .6s ease, border-color .6s ease; }
.hd-busy .hd-orb-ring svg { animation: hd-pulse 1.2s ease-in-out infinite; }
@keyframes hd-breathe { from { transform: scale(.92); } to { transform: scale(1.12); } }
@keyframes hd-pulse { 50% { opacity: .35; } }
.hd-name { margin: 0; font-size: 18px; font-weight: 700; color: #f2f3f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hd-state { margin-top: 4px; display: inline-flex; align-items: center; gap: 6px; color: rgba(235,237,245,.62); font-weight: 500; font-size: 14px; }
.hd-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hd-tint); transition: background .6s ease; }
.hd-detail { margin-top: 2px; color: rgba(235,237,245,.38); font-size: 12px; min-height: 16px; }
.hd-card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 0 0 8px; border-radius: 14px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.08); }
.hd-card-icon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; }
.hd-card-text { flex: 1; min-width: 0; }
.hd-card-text b { display: block; font-size: 14px; color: #f2f3f7; }
.hd-card-text span { display: block; font-size: 12px; color: rgba(235,237,245,.62); }
.hd-card .hd-pill { flex: none; min-width: 0 !important; width: auto !important; padding: 4px 14px !important; border-radius: 999px !important; font-size: 13px !important; }
.hd-check { flex: none; color: #4dd98c; display: grid; }
.hd-spinner { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.15); border-top-color: #66a6ff; animation: hd-spin .8s linear infinite; }
@keyframes hd-spin { to { transform: rotate(360deg); } }
.hd-tiles { display: flex; gap: 6px; margin: 4px 0 6px; }
.hd-tile { flex: 1; min-width: 0 !important; padding: 8px 0 6px !important; display: flex !important; flex-direction: column; align-items: center; gap: 3px; border-radius: 14px !important; font-size: 12px !important; }
.hd-tile svg { display: block; }
.hd-tile.hd-wake:not([disabled]) svg { color: #4dd98c; }
.hd-tile.hd-sleep:not([disabled]) svg { color: #8c8cff; }
.hd-tile.hd-restart:not([disabled]) svg { color: #ffb847; }
.hd-tile[disabled] { opacity: .45; }
.hd-note { font-size: 12px; color: rgba(235,237,245,.5); text-align: center; margin: 2px 0; }
.hd-error { font-size: 12px; color: #ff6b6b; margin: 4px 0; }
.hd-info { font-size: 12px; color: #66a6ff; margin: 4px 0; }
`;

const Icon = ({ d, size = 22, stroke, style }: { d: string; size?: number; stroke?: boolean; style?: CSSProperties }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={style} aria-hidden="true">
    {stroke ? <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d={d} /> : <path fill="currentColor" d={d} />}
  </svg>
);

const PATHS = {
  pc: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9h16V6H4Z",
  steam: "M7 7h10a5 5 0 0 1 4.9 6l-.8 3.8a2.6 2.6 0 0 1-4.5 1.2L14.4 16H9.6l-2.2 2a2.6 2.6 0 0 1-4.5-1.2L2.1 13A5 5 0 0 1 7 7Zm1 3v1.5H6.5V13H8v1.5h1.5V13H11v-1.5H9.5V10H8Zm8.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  sun: "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0-6 1.2 3.3h-2.4L12 1Zm0 22-1.2-3.3h2.4L12 23ZM1 12l3.3-1.2v2.4L1 12Zm22 0-3.3 1.2v-2.4L23 12ZM4.2 4.2l3.2 1.5-1.7 1.7-1.5-3.2Zm15.6 15.6-3.2-1.5 1.7-1.7 1.5 3.2Zm0-15.6-1.5 3.2-1.7-1.7 3.2-1.5ZM4.2 19.8l1.5-3.2 1.7 1.7-3.2 1.5Z",
  check: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm4.3 6.3-5.6 5.6-2.9-2.9-1.4 1.4 4.3 4.3 7-7-1.4-1.4Z",
  wake: "M12 3v8M7.1 6.2a7.5 7.5 0 1 0 9.8 0",
  sleep: "M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z",
  restart: "M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5",
};

// --- helpers -----------------------------------------------------------------

const FAST_POLL_MS = 4000;
const SLOW_POLL_MS = 30000;
const WATCH_FOR_MS = 90000; // how long after the last press the PC is asked to poll fast

function formatDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

function relative(date: Date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (mins < 60) return fmt.format(-mins, "minute");
  if (mins < 1440) return fmt.format(-Math.round(mins / 60), "hour");
  return fmt.format(-Math.round(mins / 1440), "day");
}

function detail(phase: string, s: Status | null, pc: Pc | undefined) {
  if (phase === "none") return "Add a PC in the HomeyDeck app";
  if (!s) return "";
  if (phase === "online" && s.uptimeSeconds != null) return `Up for ${formatDuration(s.uptimeSeconds)}${s.os ? ` on ${s.os}` : ""}`;
  if (phase === "offline" && !pc?.wake) return "Add its MAC and DDNS name in the app to wake it";
  if (phase === "offline" && s.lastSeen) return `Last seen ${relative(new Date(s.lastSeen))}`;
  if (phase === "offline") return "The agent hasn't checked in yet";
  return "";
}

function confirm(title: string, text: string, verb: string, onOK: () => void) {
  showModal(<ConfirmModal strTitle={title} strDescription={text} strOKButtonText={verb} onOK={onOK} />);
}

// --- sign in -----------------------------------------------------------------

function SignIn({ server: initialServer, onSignedIn }: { server: string; onSignedIn: () => void }) {
  const [server, setServer] = useState(initialServer.replace(/^https:\/\//, ""));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await login(server, username, password);
      if (!r.ok) return setError(r.error || "Couldn't sign in.");
      setPassword("");
      onSignedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="Sign in">
      <PanelSectionRow>
        <TextField label="Server" value={server} onChange={(e) => setServer(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField label="Password" bIsPassword value={password} onChange={(e) => setPassword(e.target.value)} />
      </PanelSectionRow>
      {error && <div className="hd-error">{error}</div>}
      <PanelSectionRow>
        <DialogButton disabled={busy || !username || !password || !server} onClick={submit}>
          {busy ? "Signing in…" : "Sign in"}
        </DialogButton>
      </PanelSectionRow>
      <div className="hd-note">Use your HomeyDeck account. New accounts and PCs are added in the HomeyDeck app.</div>
    </PanelSection>
  );
}

// --- the deck ----------------------------------------------------------------

function Deck({ session, initialPc, onSignedOut }: { session: Session; initialPc: string; onSignedOut: (message?: string) => void }) {
  const pcs = session.pcs ?? [];
  const [pcId, setPcId] = useState(() => (pcs.some((p) => p.id === initialPc) ? initialPc : pcs[0]?.id ?? ""));
  const [status, setStatus] = useState<Status | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const lastTouch = useRef(Date.now());
  const pcRef = useRef(pcId);
  pcRef.current = pcId;

  const watching = () => Date.now() - lastTouch.current < WATCH_FOR_MS;

  const handle = (r: Result) => {
    if (r.code === "signed_out" || r.code === "disabled") onSignedOut(r.code === "disabled" ? r.error : undefined);
  };

  const refresh = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const s = await getStatus(pc, watching());
    if (pc !== pcRef.current) return;
    if (!s.ok) {
      handle(s);
      if (s.code === "pc_removed") return onSignedOut("reload");
      return setMessage({ kind: "error", text: s.error || "Couldn't load the status." });
    }
    setStatus(s);
    setUpdatedAt(Date.now());
    if (s.steamRunning || !s.online) setLaunching(false);
  };

  // Polls while the panel is open: fast just after a press, slower after.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const loop = async () => {
      await refresh().catch(() => {});
      if (alive) timer = setTimeout(loop, watching() ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    setStatus(null);
    setUpdatedAt(null);
    setLaunching(false);
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pcId]);

  const run = async (label: string, action: string) => {
    if (busy) return;
    lastTouch.current = Date.now();
    setBusy(true);
    setMessage(null);
    try {
      const r = await sendCommand(pcId, action);
      if (!r.ok) {
        handle(r);
        setMessage({ kind: "error", text: `${label}: ${r.error}` });
      } else if (r.pending) {
        setMessage({ kind: "info", text: `${label}: sent. The PC will pick it up within 30 seconds.` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: `${label}: ${e}` });
    } finally {
      setBusy(false);
      await refresh().catch(() => {});
    }
  };

  const pc = pcs.find((p) => p.id === pcId);
  const phase = !pcId ? "none" : status?.phase ?? "unknown";
  const info = PHASES[phase] ?? PHASES.unknown;
  const online = phase === "online";
  const tint = TINT[phase] ?? TINT.unknown;
  const running = online && status?.steamRunning;
  const sun = status?.sunshineRunning;

  const heroClass = ["hd-hero", info.busy || busy ? "hd-busy" : "", phase === "offline" || phase === "unknown" ? "hd-dim" : ""].join(" ");
  const heroStyle = { "--hd-tint": tint, "--hd-tint-soft": `${tint}8c` } as CSSProperties;

  let steamAction: ReactNode = null;
  if (launching && !running && online) steamAction = <div className="hd-spinner" />;
  else if (running) steamAction = <span className="hd-check"><Icon d={PATHS.check} size={24} /></span>;
  else if (online)
    steamAction = (
      <DialogButton
        className="hd-pill"
        disabled={busy}
        onClick={() => {
          setLaunching(true);
          run("Launch Steam", "launch_steam");
        }}
      >
        Launch
      </DialogButton>
    );

  return (
    <>
      <PanelSection>
        {pcs.length > 1 && (
          <PanelSectionRow>
            <DropdownItem
              label="PC"
              rgOptions={pcs.map((p) => ({ data: p.id, label: p.name }))}
              selectedOption={pcId}
              onChange={(o) => {
                setPcId(o.data);
                selectPc(o.data);
              }}
            />
          </PanelSectionRow>
        )}

        <div className={heroClass} style={heroStyle}>
          <div className="hd-orb">
            <div className="hd-orb-glow" />
            <div className="hd-orb-ring">
              <Icon d={PATHS.pc} size={32} />
            </div>
          </div>
          <div className="hd-name">{pc?.name || status?.hostname || "My PC"}</div>
          <div className="hd-state">
            <span className="hd-dot" />
            {info.title}
          </div>
          <div className="hd-detail">{detail(phase, status, pc)}</div>
        </div>

        {pcId && (
          <Focusable flow-children="horizontal" className="hd-card">
            <div className="hd-card-icon" style={{ color: "#66a6ff", background: "rgba(102,166,255,.14)" }}>
              <Icon d={PATHS.steam} />
            </div>
            <div className="hd-card-text">
              <b>Steam</b>
              <span>{!online ? "Available when the PC is on" : running ? "Running, ready for Remote Play" : launching ? "Starting…" : "Not running"}</span>
            </div>
            {steamAction}
          </Focusable>
        )}

        {/* Sunshine is status only, hidden until the agent reports it (v0.4+). */}
        {pcId && sun != null && (
          <div className="hd-card">
            <div className="hd-card-icon" style={{ color: "#ffc247", background: "rgba(255,194,71,.14)" }}>
              <Icon d={PATHS.sun} />
            </div>
            <div className="hd-card-text">
              <b>Sunshine</b>
              <span>{!online ? "Available when the PC is on" : sun ? "Running, ready to stream" : "Not running"}</span>
            </div>
            {online && sun && (
              <span className="hd-check">
                <Icon d={PATHS.check} size={24} />
              </span>
            )}
          </div>
        )}

        {pcId && (
          <Focusable flow-children="horizontal" className="hd-tiles">
            <DialogButton
              className="hd-tile hd-wake"
              disabled={busy || !pc?.wake || !["offline", "unknown", "sleeping"].includes(phase)}
              onClick={() => run("Wake", "wake")}
            >
              <Icon d={PATHS.wake} size={22} stroke />
              Wake
            </DialogButton>
            <DialogButton
              className="hd-tile hd-sleep"
              disabled={busy || !online}
              onClick={() => confirm("Put the PC to sleep?", "You can wake it again from here.", "Sleep", () => run("Sleep", "sleep"))}
            >
              <Icon d={PATHS.sleep} size={22} />
              Sleep
            </DialogButton>
            <DialogButton
              className="hd-tile hd-restart"
              disabled={busy || !online}
              onClick={() => confirm("Restart the PC?", "Anything unsaved on the PC will be lost.", "Restart", () => run("Restart", "reboot"))}
            >
              <Icon d={PATHS.restart} size={22} stroke />
              Restart
            </DialogButton>
          </Focusable>
        )}

        {message && <div className={message.kind === "error" ? "hd-error" : "hd-info"}>{message.text}</div>}
        {updatedAt && (
          <div className="hd-note">
            Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Account">
        <div className="hd-note" style={{ textAlign: "left", marginBottom: 6 }}>
          Signed in as {session.user?.name}
        </div>
        <PanelSectionRow>
          <DialogButton
            onClick={() =>
              confirm("Sign out of HomeyDeck?", "You can sign in again any time.", "Sign out", async () => {
                await logout();
                onSignedOut();
              })
            }
          >
            Sign out
          </DialogButton>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

// --- root --------------------------------------------------------------------

function Content() {
  const [config, setConfig] = useState<Config | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  const load = async () => {
    setError("");
    const c = await getConfig();
    setConfig(c);
    if (!c.signedIn) return setSession(null);
    const s = await getSession();
    if (s.ok) {
      setSession(s);
      setGeneration((g) => g + 1);
    } else if (s.status === 401 || s.status === 403) {
      setSession(null);
      setConfig({ ...c, signedIn: false });
      if (s.code === "disabled") setError(s.error || "");
    } else {
      setError(s.error || "Can't reach the server.");
    }
  };

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, []);

  const signedOut = (message?: string) => {
    if (message === "reload") return void load();
    setSession(null);
    setConfig((c) => (c ? { ...c, signedIn: false } : c));
    if (message) setError(message);
  };

  let body: ReactNode;
  if (!config) body = <div className="hd-note">Loading…</div>;
  else if (session) body = <Deck key={generation} session={session} initialPc={config.pc} onSignedOut={signedOut} />;
  else if (!config.signedIn) body = <SignIn server={config.server} onSignedIn={() => load()} />;
  else
    body = (
      <PanelSection>
        <PanelSectionRow>
          <DialogButton onClick={() => load()}>Try again</DialogButton>
        </PanelSectionRow>
      </PanelSection>
    );

  return (
    <>
      <style>{CSS}</style>
      {error && <div className="hd-error" style={{ padding: "0 16px" }}>{error}</div>}
      {body}
    </>
  );
}

export default definePlugin(() => ({
  name: "HomeyDeck",
  titleView: <div className={staticClasses.Title}>HomeyDeck</div>,
  content: <Content />,
  icon: <Icon d={PATHS.pc} size={20} />,
}));
