import tempfile
import unittest
import zipfile
import json
import hashlib
import shutil
import subprocess
from pathlib import Path

from scripts.server_package import (
    SERVER_PACKAGE_ROOT,
    build_clean_server_package,
    validate_clean_server_package,
)


class CleanServerPackageTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("powershell"), "Windows PowerShell required")
    def test_migration_checker_validates_isolated_data_and_rejects_corruption(self):
        source = Path(__file__).resolve().parents[1] / "scripts/check-server-environment.ps1"
        with tempfile.TemporaryDirectory(prefix="linkey-checker-test-") as tmp:
            root = Path(tmp)
            shutil.copyfile(source, root / "check.ps1")
            for name in ("package.json", "src/server.js", "admin/admin.js", "public/index.html", "Linkey-服务端管理系统.exe", "qq_chat.db", "uploads/a.txt"):
                self._write(root, name)
            def entry(name):
                data = (root / name).read_bytes()
                return {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            manifest = {"formatVersion": 1, "linkeyVersion": "1.0.0", "exportedAt": "2026-09-08T00:00:00Z", "hasAdminPassword": True, "database": entry("qq_chat.db"), "attachments": [entry("uploads/a.txt")], "attachmentCount": 1, "attachmentBytes": 7}
            def run(deep=False):
                (root / "迁移清单.json").write_text(json.dumps(manifest), encoding="utf-8")
                result = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(root / "check.ps1")] + (["-DeepMigrationCheck"] if deep else []), capture_output=True)
                self.checker_output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
                return result.returncode
            self.assertEqual(run(True), 0, self.checker_output)
            self._write(root, "uploads/a.txt", b"changed")
            self.assertEqual(run(False), 0)
            self.assertEqual(run(True), 1)
            self._write(root, "uploads/a.txt")
            self._write(root, "qq_chat.db", b"changed")
            self.assertEqual(run(False), 1)
            self._write(root, "qq_chat.db")
            for unsafe in ("uploads/../qq_chat.db", "uploads/a.txt:stream", "/qq_chat.db", "uploads\\a.txt"):
                manifest["attachments"][0]["path"] = unsafe
                self.assertEqual(run(), 1, unsafe)

    def _write(self, root: Path, relative: str, content: bytes = b"fixture") -> None:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    def test_builds_allowlisted_server_package_without_existing_data(self):
        with tempfile.TemporaryDirectory(prefix="linkey-server-package-test-") as tmp:
            project = Path(tmp) / "project"
            output = Path(tmp) / "clean-server.zip"

            required_files = [
                "admin/admin.js",
                "admin/public/index.html",
                "src/server.js",
                "public/index.html",
                "package.json",
                "README.md",
                "admin-start.cmd",
                "admin-stop.cmd",
                "start.bat",
                "开启外网联机.cmd",
                "cloudflared.exe",
                "dist/Linkey-服务端管理系统.exe",
                "scripts/tunnel-start.mjs",
                "scripts/create-migration-archive.ps1",
                "scripts/check-server-environment.ps1",
                "docs/新电脑服务器部署说明.txt",
            ]
            for relative in required_files:
                self._write(project, relative)

            forbidden_files = [
                "qq_chat.db",
                "uploads/private-photo.png",
                "logs/server.log",
                "backups/old.db",
                "test-logs/test-admin.db",
                "admin-config.json",
                "public-url.json",
                "public/public-url.json",
                "tests/admin.test.js",
                "scripts/apk-signing-key.pem",
                "public/downloads/Linkey-PC.zip",
            ]
            for relative in forbidden_files:
                self._write(project, relative, b"must-not-leak")

            build_clean_server_package(project, output)
            validate_clean_server_package(output)

            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())

            prefix = SERVER_PACKAGE_ROOT + "/"
            expected = {
                prefix + "admin/admin.js",
                prefix + "admin/public/index.html",
                prefix + "src/server.js",
                prefix + "public/index.html",
                prefix + "package.json",
                prefix + "Linkey-服务端管理系统.exe",
                prefix + "检查服务器环境.ps1",
                prefix + "新电脑服务器部署说明.txt",
                prefix + "cloudflared.exe",
                prefix + "scripts/create-migration-archive.ps1",
                prefix + "uploads/",
                prefix + "logs/",
                prefix + "backups/",
            }
            self.assertTrue(expected.issubset(names), expected - names)
            self.assertFalse(any(name.endswith("/.keep") for name in names), names)

            denied_fragments = (
                "qq_chat.db",
                "private-photo.png",
                "server.log",
                "old.db",
                "test-admin.db",
                "admin-config.json",
                "public-url.json",
                "tests/",
                "apk-signing-key.pem",
                "public/downloads/",
            )
            for name in names:
                self.assertFalse(any(fragment in name for fragment in denied_fragments), name)

    def test_full_packaging_script_builds_the_clean_server_artifact(self):
        project_root = Path(__file__).resolve().parents[1]
        package_script = (project_root / "scripts/package_dist.py").read_text(encoding="utf-8")
        build_script = (project_root / "scripts/build_all.py").read_text(encoding="utf-8")

        self.assertIn("from server_package import build_clean_server_package", package_script)
        self.assertIn("Linkey-全新服务器迁移包.zip", package_script)
        self.assertIn("Linkey-全新服务器迁移包.zip", build_script)

    def test_portable_start_scripts_do_not_contain_a_developer_profile_path(self):
        project_root = Path(__file__).resolve().parents[1]
        for relative in ("admin-start.cmd", "start.bat"):
            script = (project_root / relative).read_text(encoding="utf-8")
            self.assertNotIn(r"C:\Users\wfz", script, relative)

    def test_environment_checker_requires_node_24_for_node_sqlite(self):
        project_root = Path(__file__).resolve().parents[1]
        checker = (project_root / "scripts/check-server-environment.ps1").read_text(encoding="utf-8")
        guide = (project_root / "docs/新电脑服务器部署说明.txt").read_text(encoding="utf-8")

        self.assertIn("$nodeMajor -lt 24", checker)
        self.assertIn("Node.js 24", guide)


if __name__ == "__main__":
    unittest.main()
