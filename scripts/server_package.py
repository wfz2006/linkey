import os
import zipfile
from pathlib import Path


SERVER_PACKAGE_ROOT = "Linkey-全新服务器"

SOURCE_TREES = ("admin", "src", "public")
SKIPPED_TREE_PREFIXES = (
    "public/downloads/",
    "public/uploads/",
)
SKIPPED_TREE_FILES = {"public/public-url.json"}
SKIPPED_PARTS = {"__pycache__", ".git", ".superpowers"}

ROOT_FILES = (
    "package.json",
    "README.md",
    "admin-start.cmd",
    "admin-stop.cmd",
    "start.bat",
    "开启外网联机.cmd",
)

OPTIONAL_ROOT_FILES = (
    "cloudflared.exe",
    "app.ico",
)

MAPPED_FILES = (
    ("scripts/create-migration-archive.ps1", "scripts/create-migration-archive.ps1"),
    ("dist/Linkey-服务端管理系统.exe", "Linkey-服务端管理系统.exe"),
    ("scripts/tunnel-start.mjs", "scripts/tunnel-start.mjs"),
    ("scripts/check-server-environment.ps1", "检查服务器环境.ps1"),
    ("docs/新电脑服务器部署说明.txt", "新电脑服务器部署说明.txt"),
)

REQUIRED_PACKAGE_FILES = {
    "scripts/create-migration-archive.ps1",
    "admin/admin.js",
    "src/server.js",
    "public/index.html",
    "package.json",
    "admin-start.cmd",
    "admin-stop.cmd",
    "Linkey-服务端管理系统.exe",
    "检查服务器环境.ps1",
    "新电脑服务器部署说明.txt",
}

DENIED_NAMES = {
    "qq_chat.db",
    "admin-config.json",
    "public-url.json",
    "apk-signing-key.pem",
}


def _archive_name(relative: str) -> str:
    normalized = relative.replace("\\", "/").lstrip("/")
    return f"{SERVER_PACKAGE_ROOT}/{normalized}"


def _is_allowed_tree_file(relative: str) -> bool:
    normalized = relative.replace("\\", "/")
    parts = set(Path(normalized).parts)
    if parts & SKIPPED_PARTS:
        return False
    if normalized in SKIPPED_TREE_FILES:
        return False
    return not any(normalized.startswith(prefix) for prefix in SKIPPED_TREE_PREFIXES)


def build_clean_server_package(project_root, output_zip):
    project_root = Path(project_root).resolve()
    output_zip = Path(output_zip).resolve()
    output_zip.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as archive:
        for tree_name in SOURCE_TREES:
            tree_root = project_root / tree_name
            if not tree_root.is_dir():
                continue
            for source in sorted(tree_root.rglob("*")):
                if not source.is_file():
                    continue
                relative = source.relative_to(project_root).as_posix()
                if _is_allowed_tree_file(relative):
                    archive.write(source, _archive_name(relative))

        for relative in ROOT_FILES:
            source = project_root / relative
            if not source.is_file():
                raise FileNotFoundError(f"服务器迁移包缺少必需文件: {relative}")
            archive.write(source, _archive_name(relative))

        for relative in OPTIONAL_ROOT_FILES:
            source = project_root / relative
            if source.is_file():
                archive.write(source, _archive_name(relative))

        for source_name, destination_name in MAPPED_FILES:
            source = project_root / source_name
            if not source.is_file():
                raise FileNotFoundError(f"服务器迁移包缺少必需文件: {source_name}")
            archive.write(source, _archive_name(destination_name))

        for empty_dir in ("uploads", "logs", "backups"):
            archive.writestr(_archive_name(f"{empty_dir}/"), "")

    validate_clean_server_package(output_zip)
    return output_zip


def validate_clean_server_package(output_zip):
    output_zip = Path(output_zip)
    with zipfile.ZipFile(output_zip) as archive:
        names = archive.namelist()

    prefix = SERVER_PACKAGE_ROOT + "/"
    relative_names = {
        name[len(prefix):] if name.startswith(prefix) else name
        for name in names
    }
    missing = REQUIRED_PACKAGE_FILES - relative_names
    if missing:
        raise ValueError(f"服务器迁移包缺少文件: {sorted(missing)}")

    for relative in relative_names:
        normalized = relative.replace("\\", "/")
        parts = normalized.split("/")
        if any(part in DENIED_NAMES for part in parts):
            raise ValueError(f"服务器迁移包包含禁止文件: {normalized}")
        if normalized.startswith(("tests/", "test-logs/", "logs/", "backups/", "uploads/")):
            if normalized not in {"logs/", "backups/", "uploads/"}:
                raise ValueError(f"服务器迁移包包含业务或测试数据: {normalized}")

    return True
