import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AT_PACKAGE = ROOT / "at-webserver"
LUCI_PACKAGE = ROOT / "luci-app-at-webserver"
LOG_VIEW = (
    LUCI_PACKAGE
    / "htdocs"
    / "luci-static"
    / "resources"
    / "view"
    / "at-webserver"
    / "logs.js"
)
ACL_FILE = (
    LUCI_PACKAGE
    / "root"
    / "usr"
    / "share"
    / "rpcd"
    / "acl.d"
    / "luci-app-at-webserver.json"
)


class LuciSecurityContractTests(unittest.TestCase):
    def test_public_log_clear_cgi_is_absent_everywhere(self):
        self.assertFalse((AT_PACKAGE / "files/www/cgi-bin/at-log-clear").exists())
        for relative in (
            "at-webserver/Makefile",
            "tools/build_at_webserver_ipk.py",
            "tools/build_source_archive.py",
        ):
            self.assertNotIn(
                "at-log-clear",
                (ROOT / relative).read_text(encoding="utf-8"),
                relative,
            )

    def test_log_clear_uses_authenticated_luci_file_api_and_fixed_paths(self):
        source = LOG_VIEW.read_text(encoding="utf-8")
        self.assertIn("return fs.write(logFile, '')", source)
        self.assertIn("/tmp/at-notifications.log", source)
        self.assertIn("/var/log/at-notifications.log", source)
        self.assertNotIn("/cgi-bin/at-log-clear", source)

    def test_acl_grants_only_the_two_log_paths_for_file_writes(self):
        acl = json.loads(ACL_FILE.read_text(encoding="utf-8"))[
            "luci-app-at-webserver"
        ]
        expected_logs = {
            "/tmp/at-notifications.log",
            "/var/log/at-notifications.log",
        }
        self.assertEqual(expected_logs, set(acl["write"]["file"]))
        self.assertEqual(["write"], acl["write"]["ubus"]["file"])
        serialized = json.dumps(acl, sort_keys=True)
        for forbidden in ("exec", "remove", "firewall", '"/tmp/*"', '"/var/log/*"'):
            self.assertNotIn(forbidden, serialized)

    def test_release_versions_and_dependencies_are_coherent(self):
        at_makefile = (AT_PACKAGE / "Makefile").read_text(encoding="utf-8")
        luci_makefile = (LUCI_PACKAGE / "Makefile").read_text(encoding="utf-8")
        at_builder = (ROOT / "tools/build_at_webserver_ipk.py").read_text(
            encoding="utf-8"
        )
        luci_builder = (ROOT / "tools/build_luci_at_webserver_ipk.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("PKG_RELEASE:=34", at_makefile)
        self.assertIn("PKG_RELEASE:=35", luci_makefile)
        self.assertIn("+at-webserver +luci-app-modem", luci_makefile)
        self.assertIn('VERSION = "1.0-34"', at_builder)
        self.assertIn('VERSION = "1.0-35"', luci_builder)


if __name__ == "__main__":
    unittest.main()
