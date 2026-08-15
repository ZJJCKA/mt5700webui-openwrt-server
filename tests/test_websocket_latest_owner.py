import asyncio
import importlib.util
import inspect
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


BIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "at-webserver"
    / "files"
    / "usr"
    / "bin"
)
sys.path.insert(0, str(BIN_DIR))

for module_name in ("aiohttp", "websockets", "serial"):
    sys.modules.setdefault(module_name, types.ModuleType(module_name))

SPEC = importlib.util.spec_from_file_location(
    "at_server_latest_owner_under_test", BIN_DIR / "at-server.py"
)
AT_SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = AT_SERVER
with mock.patch("subprocess.run") as subprocess_run:
    subprocess_run.return_value = types.SimpleNamespace(returncode=1, stdout="")
    SPEC.loader.exec_module(AT_SERVER)


class FakeWebSocket:
    def __init__(self, received=None):
        self.request_headers = {
            "Origin": "http://router.lan",
            "Host": "router.lan:8765",
        }
        self.received = list(received or [])
        self.sent = []
        self.close_calls = []
        self.closed = False

    async def recv(self):
        return self.received.pop(0)

    async def send(self, payload):
        self.sent.append(payload)

    async def close(self, code=None, reason=None):
        self.close_calls.append((code, reason))
        self.closed = True


class BlockingSendWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.send_started = asyncio.Event()
        self.allow_send = asyncio.Event()

    async def send(self, payload):
        self.send_started.set()
        await self.allow_send.wait()
        self.sent.append(payload)


class WebSocketLatestOwnerTests(unittest.IsolatedAsyncioTestCase):
    def make_server(self):
        self.at_client = types.SimpleNamespace(
            connection_type="NETWORK",
            connect=mock.AsyncMock(),
            close=mock.AsyncMock(),
        )
        return AT_SERVER.WebSocketServer(self.at_client, mock.Mock())

    async def test_new_owner_replaces_old_browser_only(self):
        server = self.make_server()
        old = FakeWebSocket()
        new = FakeWebSocket()

        await server._claim_latest_owner(old)
        await server._claim_latest_owner(new)

        self.assertIs(new, server._active_owner)
        self.assertEqual({new}, server._active_connections)
        self.assertEqual(
            [(4001, "replaced_by_new_session")], old.close_calls
        )
        self.at_client.connect.assert_not_awaited()
        self.at_client.close.assert_not_awaited()

    async def test_old_cleanup_cannot_clear_new_owner(self):
        server = self.make_server()
        old = FakeWebSocket()
        new = FakeWebSocket()

        await server._claim_latest_owner(old)
        await server._claim_latest_owner(new)
        await server._release_owner(old)

        self.assertIs(new, server._active_owner)
        self.assertEqual({new}, server._active_connections)

    async def test_rejected_auth_cannot_steal_owner(self):
        server = self.make_server()
        owner = FakeWebSocket()
        rejected = FakeWebSocket([
            json.dumps({"auth_key": "wrong-key"})
        ])
        await server._claim_latest_owner(owner)

        with mock.patch.object(
            AT_SERVER, "WEBSOCKET_CONFIG", {"AUTH_KEY": "correct-key"}
        ):
            await server.handle_client(rejected)

        self.assertIs(owner, server._active_owner)
        self.assertEqual({owner}, server._active_connections)
        self.assertEqual([(None, None)], rejected.close_calls)
        self.assertFalse(owner.closed)

    async def test_broadcast_targets_only_latest_owner(self):
        server = self.make_server()
        old = FakeWebSocket()
        new = FakeWebSocket()

        await server._claim_latest_owner(old)
        await server._claim_latest_owner(new)
        await server.broadcast({"type": "proof", "data": 1})

        self.assertEqual([], old.sent)
        self.assertEqual(
            {"type": "proof", "data": 1}, json.loads(new.sent[-1])
        )

    async def test_broadcast_and_takeover_are_linearly_ordered(self):
        server = self.make_server()
        old = BlockingSendWebSocket()
        new = FakeWebSocket()
        await server._claim_latest_owner(old)

        broadcast_task = asyncio.create_task(
            server.broadcast({"type": "before-takeover"})
        )
        await old.send_started.wait()
        takeover_task = asyncio.create_task(server._claim_latest_owner(new))
        await asyncio.sleep(0)
        self.assertFalse(takeover_task.done())

        old.allow_send.set()
        await broadcast_task
        await takeover_task
        await server.broadcast({"type": "after-takeover"})

        self.assertEqual(1, len(old.sent))
        self.assertEqual("before-takeover", json.loads(old.sent[0])["type"])
        self.assertEqual(1, len(new.sent))
        self.assertEqual("after-takeover", json.loads(new.sent[0])["type"])

    def test_handoff_helpers_do_not_manage_at_client_lifecycle(self):
        source = "\n".join(
            (
                inspect.getsource(AT_SERVER.WebSocketServer._claim_latest_owner),
                inspect.getsource(AT_SERVER.WebSocketServer._release_owner),
            )
        )
        self.assertNotIn("self.at_client.", source)


if __name__ == "__main__":
    unittest.main()
