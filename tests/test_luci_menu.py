import json
import unittest
from pathlib import Path


MENU_FILE = (
    Path(__file__).resolve().parents[1]
    / "luci-app-at-webserver"
    / "root"
    / "usr"
    / "share"
    / "luci"
    / "menu.d"
    / "luci-app-at-webserver.json"
)
DEBUG_VIEW = (
    Path(__file__).resolve().parents[1]
    / "luci-app-at-webserver"
    / "htdocs"
    / "luci-static"
    / "resources"
    / "view"
    / "at-webserver"
    / "debug.js"
)


class LuciMenuTests(unittest.TestCase):
    def test_menu_is_available_under_services(self):
        menu = json.loads(MENU_FILE.read_text(encoding="utf-8"))
        entry = menu["admin/services/at-webserver"]
        self.assertEqual("AT WebServer", entry["title"])
        self.assertEqual(-10, entry["order"])
        self.assertEqual(
            "首页", menu["admin/services/at-webserver/home"]["title"]
        )
        self.assertEqual(
            "配置", menu["admin/services/at-webserver/config"]["title"]
        )
        self.assertEqual(
            "日志查看", menu["admin/services/at-webserver/logs"]["title"]
        )
        self.assertNotIn("admin/modem/tdtech", menu)

    def test_legacy_debug_output_does_not_interpret_modem_html(self):
        source = DEBUG_VIEW.read_text(encoding="utf-8")
        self.assertNotIn("innerHTML", source)
        self.assertIn("messageEl.textContent", source)


if __name__ == "__main__":
    unittest.main()
