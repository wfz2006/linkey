import os
import shutil
import sys
import tempfile
import zipfile

from network_utils import get_lan_ip
from server_package import build_clean_server_package


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

DIST = "dist"


def make_dist():
    downloads_dir = "public/downloads"
    os.makedirs(DIST, exist_ok=True)
    os.makedirs(downloads_dir, exist_ok=True)

    ip = get_lan_ip()
    staging = tempfile.mkdtemp(prefix="linkey-pkg-")
    pc_dir = os.path.join(staging, "Linkey-PC")
    mobile_dir = os.path.join(staging, "Linkey-Android")
    os.makedirs(pc_dir, exist_ok=True)
    os.makedirs(mobile_dir, exist_ok=True)

    shutil.copy("dist/Linkey.exe", os.path.join(pc_dir, "Linkey.exe"))
    if os.path.exists("dist/Linkey-安装程序.exe"):
        shutil.copy(
            "dist/Linkey-安装程序.exe",
            os.path.join(pc_dir, "Linkey-安装程序.exe"),
        )
    if os.path.exists("app.ico"):
        shutil.copy("app.ico", os.path.join(pc_dir, "app.ico"))

    with open(os.path.join(pc_dir, "Linkey-Config.json"), "w", encoding="utf-8") as file:
        file.write('{\n  "server_url": "http://' + ip + ':3000"\n}\n')

    pc_readme = f"""============================================================
              Linkey 客户端 (电脑版) 使用说明
============================================================

【两种使用方式】：

方式一 (绿色直接运行，推荐)：
  直接双击【Linkey.exe】即可立即启动聊天！
  无需安装任何依赖，即开即用。

方式二 (一键向导安装)：
  双击【Linkey-安装程序.exe】，点击【立即一键安装】，
  程序会自动安装到您的电脑并生成桌面快捷图标与开始菜单图标。

------------------------------------------------------------
【局域网 / 朋友联机指南】：
  1. 默认服务器地址预设为房主局域网 IP：http://{ip}:3000
  2. 只要朋友与您连接在同一个 WiFi / 局域网（或使用同一热点），
     朋友打开本软件即可自动连入，实时互相收发消息、发动态、建群聊！
  3. 如果需要修改服务器地址（例如房主开启公网隧道后）：
     在软件顶部点击【服务器设置】(或按 Ctrl+S)，输入新地址并点击
     【保存并连接】即可！
------------------------------------------------------------
"""
    with open(os.path.join(pc_dir, "电脑版使用与局域网联机说明.txt"), "w", encoding="utf-8") as file:
        file.write(pc_readme)

    bat_content = r"""@echo off
chcp 65001 >nul
echo 正在安装 Linkey 客户端到您的电脑...
set "TARGET_DIR=%LOCALAPPDATA%\Linkey"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
copy /Y "Linkey.exe" "%TARGET_DIR%\Linkey.exe" >nul
if exist "app.ico" copy /Y "app.ico" "%TARGET_DIR%\app.ico" >nul
if exist "Linkey-Config.json" copy /Y "Linkey-Config.json" "%TARGET_DIR%\Linkey-Config.json" >nul

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([System.IO.Path]::Combine([System.Environment]::GetFolderPath('DesktopDirectory'), 'Linkey.lnk')); $s.TargetPath = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Linkey', 'Linkey.exe'); $s.WorkingDirectory = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Linkey'); $s.Description = 'Linkey 客户端'; $s.IconLocation = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Linkey', 'app.ico,0'); $s.Save()"

echo Linkey 安装成功！已在桌面生成快捷方式。
echo 正在启动 Linkey...
start "" "%TARGET_DIR%\Linkey.exe"
"""
    with open(os.path.join(pc_dir, "Linkey-一键安装与创建桌面图标.bat"), "w", encoding="utf-8") as file:
        file.write(bat_content)

    shutil.copy(
        "dist/Linkey-Android.apk",
        os.path.join(mobile_dir, "Linkey-Android.apk"),
    )
    mobile_readme = f"""============================================================
              Linkey 手机版 (安卓 Android) 使用说明
============================================================

【安装与使用方式】：

方式一 (APK 原生安装)：
  将【Linkey-Android.apk】发送至安卓手机，点击直接安装。
  已配置 v1+v2 双签名与网络安全权限，Android 5 ~ 15 均可安装。

方式二 (手机浏览器扫码免安装 PWA)：
  手机连接同一 WiFi，打开手机浏览器访问：
  http://{ip}:3000
  点击【添加到手机主屏幕】，即可作为全屏 App 使用。

------------------------------------------------------------
【局域网联机提示】：
  请确保手机与运行 Linkey 服务端的电脑处于同一个 WiFi 局域网下。
  若房主开启了【公网穿透联机】，使用前台分享的公网地址即可在任何
  网络环境下访问。
------------------------------------------------------------
"""
    with open(os.path.join(mobile_dir, "手机版安装与扫码使用说明.txt"), "w", encoding="utf-8") as file:
        file.write(mobile_readme)

    def zip_folder(folder_path, output_zip):
        with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as archive:
            for root, _, files in os.walk(folder_path):
                for filename in files:
                    full_path = os.path.join(root, filename)
                    relative = os.path.relpath(full_path, os.path.dirname(folder_path))
                    archive.write(full_path, relative)
        print(f"[ZIP SUCCESS] Generated {output_zip} ({os.path.getsize(output_zip)} bytes)")

    zip_folder(pc_dir, os.path.join(downloads_dir, "Linkey-PC.zip"))
    zip_folder(mobile_dir, os.path.join(downloads_dir, "Linkey-Mobile.zip"))

    all_in_one = os.path.join(DIST, "Linkey-全平台安装包.zip")
    with zipfile.ZipFile(all_in_one, "w", zipfile.ZIP_DEFLATED) as archive:
        for folder in (pc_dir, mobile_dir):
            for root, _, files in os.walk(folder):
                for filename in files:
                    full_path = os.path.join(root, filename)
                    archive.write(full_path, os.path.relpath(full_path, staging))
    print(f"[ALL-IN-ONE ZIP SUCCESS] Generated {all_in_one}")
    shutil.copy(all_in_one, os.path.join(downloads_dir, "Linkey-AllInOne.zip"))

    server_package = os.path.join(DIST, "Linkey-全新服务器迁移包.zip")
    build_clean_server_package(os.getcwd(), server_package)
    print(
        f"[SERVER PACKAGE SUCCESS] Generated {server_package} "
        f"({os.path.getsize(server_package)} bytes)"
    )

    shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    make_dist()
