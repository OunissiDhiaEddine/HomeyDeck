"""
Runs main.py's client against the real HomeyDeck API (web/scripts/dev.js,
with a throwaway Redis), the way the Decky panel uses it:
  python3 -m unittest discover -s tests -v
Needs node and redis-server, as the web tests do.
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DECKY = os.path.dirname(HERE)
WEB = os.path.join(os.path.dirname(DECKY), "web")
sys.path.insert(0, DECKY)

import main  # noqa: E402

ADMIN, PASSWORD = "admin", "test-password-123"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def agent_post(base, path, token, body):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


class BackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        port = free_port()
        cls.base = f"http://127.0.0.1:{port}"
        env = dict(os.environ, PORT=str(port), ADMIN_USERNAME=ADMIN, ADMIN_PASSWORD=PASSWORD, DATA_KEY="x" * 43)
        cls.server = subprocess.Popen(["node", os.path.join(WEB, "scripts", "dev.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("the dev server didn't start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait()

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        main.Plugin.client = main.Client(self.dir)
        self.plugin = main.Plugin()

    def call(self, name, *args):
        return asyncio.run(getattr(self.plugin, name)(*args))

    def test_normalize_server(self):
        self.assertEqual(main.normalize_server("homeydeck.vercel.app/"), "https://homeydeck.vercel.app")
        self.assertEqual(main.normalize_server("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000")
        self.assertIsNone(main.normalize_server(""))
        self.assertIsNone(main.normalize_server("ftp://x"))

    def test_signed_out(self):
        self.assertFalse(self.call("get_config")["signedIn"])
        r = self.call("session")
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "signed_out")

    def test_wrong_password(self):
        r = self.call("login", self.base, ADMIN, "nope-nope-nope")
        self.assertFalse(r["ok"])
        self.assertEqual(r["status"], 401)
        self.assertEqual(r["error"], "Wrong username or password.")

    def test_unreachable(self):
        r = self.call("login", "http://127.0.0.1:1", ADMIN, PASSWORD)
        self.assertFalse(r["ok"])
        self.assertEqual(r["status"], 0)

    def test_full_flow(self):
        r = self.call("login", self.base, ADMIN, PASSWORD)
        self.assertTrue(r["ok"], r)
        self.assertTrue(self.call("get_config")["signedIn"])
        # The cookie is kept privately on disk.
        path = os.path.join(self.dir, main.SETTINGS_FILE)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

        # A second client (the plugin after a restart) reads it back.
        main.Plugin.client = main.Client(self.dir)
        s = self.call("session")
        self.assertTrue(s["ok"], s)
        self.assertEqual(s["user"]["name"], ADMIN)
        self.assertEqual(s["pcs"], [])

        # Add and pair a PC as the PWA and the agent would.
        add = main.Plugin.client.request("/api/pcs", {"action": "add", "name": "Gaming PC"})
        self.assertTrue(add["ok"], add)
        token = agent_post(self.base, "/api/agent/pair", None, {"code": add["code"], "hostname": "DESKTOP"})["token"]
        pc = self.call("session")["pcs"][0]["id"]
        self.call("select_pc", pc)
        self.assertEqual(self.call("get_config")["pc"], pc)

        st = self.call("status", pc, True)
        self.assertTrue(st["ok"], st)
        self.assertEqual(st["phase"], "offline")
        r = self.call("command", pc, "sleep")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "The PC is offline.")

        agent_post(self.base, "/api/agent/poll", token, {"hostname": "DESKTOP", "steamRunning": False, "sunshineRunning": True, "uptimeSeconds": 60})
        st = self.call("status", pc, True)
        self.assertEqual(st["phase"], "online")
        self.assertFalse(st["steamRunning"])
        self.assertTrue(st["sunshineRunning"])

        # The agent answers the command on its next poll.
        def agent():
            for _ in range(50):
                cmds = agent_post(self.base, "/api/agent/poll", token, {"hostname": "DESKTOP", "steamRunning": False})["commands"]
                for c in cmds:
                    agent_post(self.base, "/api/agent/result", token, {"id": c["id"], "action": c["action"], "ok": True})
                    return
                time.sleep(0.2)

        import threading

        t = threading.Thread(target=agent)
        t.start()
        r = self.call("command", pc, "launch_steam")
        t.join()
        self.assertTrue(r["ok"], r)
        self.assertFalse(r.get("pending", False))

        self.assertFalse(self.call("command", pc, "format_disk")["ok"])

        self.assertTrue(self.call("logout")["ok"])
        self.assertFalse(self.call("get_config")["signedIn"])


if __name__ == "__main__":
    unittest.main()
