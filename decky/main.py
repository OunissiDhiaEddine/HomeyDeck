"""
HomeyDeck for Decky Loader: the Python side.

It talks to a HomeyDeck server (the same API the PWA uses) and keeps the
session cookie in the plugin's settings folder, so the panel never handles
it. Only the standard library is used, to keep the plugin small.

Every method returns a dict: {"ok": True, ...} or
{"ok": False, "error": "...", "code": "...", "status": 401}.
"""

import asyncio
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

try:
    import decky  # provided by Decky Loader
except ImportError:  # running the tests outside Decky
    decky = None

DEFAULT_SERVER = "https://homeydeck.vercel.app"
COOKIE = "hd_session"
TIMEOUT_S = 15
COMMAND_TIMEOUT_S = 55  # the server waits up to 40 s for the PC to answer
SETTINGS_FILE = "settings.json"
CA_FILES = ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt")
ACTIONS = ("wake", "launch_steam", "sleep", "reboot")


def log(message):
    if decky:
        decky.logger.info(message)


def ssl_context():
    """Decky's bundled Python may not find the system certificates by itself."""
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs():
        for path in CA_FILES:
            if os.path.exists(path):
                ctx.load_verify_locations(cafile=path)
                break
    return ctx


def normalize_server(raw):
    """'homeydeck.vercel.app' → 'https://homeydeck.vercel.app'. None if it's not a URL."""
    raw = str(raw or "").strip().rstrip("/")
    if not raw:
        return None
    if "://" not in raw:
        raw = "https://" + raw
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("https", "http") or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def friendly(error):
    if not error:
        return ""
    error = error[0].upper() + error[1:]
    return error if error[-1] in ".!?" else error + "."


class Client:
    """HTTP calls to one HomeyDeck server, with the session cookie."""

    def __init__(self, settings_dir):
        self.path = os.path.join(settings_dir, SETTINGS_FILE)
        self.settings = {"server": DEFAULT_SERVER, "cookie": "", "pc": ""}
        try:
            with open(self.path, encoding="utf-8") as f:
                self.settings.update(json.load(f))
        except (OSError, ValueError):
            pass
        self._ctx = None

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        # The cookie signs in to the account, so only this user can read it.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.settings, f)
        os.replace(tmp, self.path)

    def request(self, path, body=None, timeout=TIMEOUT_S):
        server = self.settings["server"]
        headers = {"Accept": "application/json", "User-Agent": "HomeyDeck-Decky"}
        if self.settings["cookie"]:
            headers["Cookie"] = f"{COOKIE}={self.settings['cookie']}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
            # The server only takes changes from its own origin, as a browser
            # would send. This is the server's own app, so it says so.
            headers["Origin"] = server
        req = urllib.request.Request(server + path, data=data, headers=headers, method="POST" if body is not None else "GET")
        if server.startswith("https://") and self._ctx is None:
            self._ctx = ssl_context()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ctx if server.startswith("https://") else None) as res:
                status, raw, cookies = res.status, res.read(), res.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as err:
            status, raw, cookies = err.code, err.read(), err.headers.get_all("Set-Cookie") or []
        except (urllib.error.URLError, OSError, ValueError) as err:
            reason = getattr(err, "reason", err)
            log(f"request {path} failed: {reason}")
            return {"ok": False, "status": 0, "error": f"Can't reach the server ({reason})."}

        self._take_cookie(cookies)
        try:
            result = json.loads(raw or b"{}")
        except ValueError:
            result = {}
        if not isinstance(result, dict):
            result = {}
        if status >= 400 or result.get("ok") is False:
            result["ok"] = False
            result["status"] = status
            result["error"] = friendly(result.get("error")) or f"The server answered {status}."
            if result.get("code") in ("signed_out", "disabled"):
                self.settings["cookie"] = ""
                self.save()
        else:
            result.setdefault("ok", True)
        return result

    def _take_cookie(self, headers):
        for header in headers:
            name, _, rest = header.partition("=")
            if name.strip() != COOKIE:
                continue
            value = urllib.parse.unquote(rest.split(";", 1)[0].strip())
            if value != self.settings["cookie"]:
                self.settings["cookie"] = value
                self.save()


class Plugin:
    client = None

    async def _main(self):
        Plugin.client = Client(decky.DECKY_PLUGIN_SETTINGS_DIR)
        log("HomeyDeck loaded")

    async def _unload(self):
        pass

    async def _uninstall(self):
        pass

    async def _call(self, *args, **kwargs):
        return await asyncio.get_running_loop().run_in_executor(None, lambda: Plugin.client.request(*args, **kwargs))

    async def get_config(self):
        s = Plugin.client.settings
        return {"server": s["server"], "signedIn": bool(s["cookie"]), "pc": s["pc"]}

    async def login(self, server, username, password):
        url = normalize_server(server)
        if not url:
            return {"ok": False, "error": "Enter the server's address, like homeydeck.vercel.app."}
        c = Plugin.client
        if url != c.settings["server"]:
            c.settings.update(server=url, cookie="", pc="")
            c.save()
        return await self._call("/api/session", {"action": "login", "username": str(username).strip(), "password": str(password)})

    async def logout(self):
        # Signed out here even if the server can't be reached right now.
        await self._call("/api/session", {"action": "logout"})
        Plugin.client.settings.update(cookie="", pc="")
        Plugin.client.save()
        return {"ok": True}

    async def session(self):
        if not Plugin.client.settings["cookie"]:
            return {"ok": False, "status": 401, "code": "signed_out", "error": "Please sign in."}
        return await self._call("/api/session")

    async def select_pc(self, pc):
        Plugin.client.settings["pc"] = str(pc or "")
        Plugin.client.save()
        return {"ok": True}

    async def status(self, pc, watch):
        query = urllib.parse.urlencode({"pc": pc, "watch": 1 if watch else 0})
        return await self._call(f"/api/status?{query}")

    async def command(self, pc, action):
        if action not in ACTIONS:
            return {"ok": False, "error": "Unknown action."}
        return await self._call("/api/command", {"pc": pc, "action": action}, timeout=COMMAND_TIMEOUT_S)
