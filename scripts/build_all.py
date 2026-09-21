import os
import sys
import shutil
import subprocess

from network_utils import get_lan_ip

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

DIST = "dist"

def run_cmd(cmd):
    p = subprocess.run(cmd, shell=True)
    if p.returncode != 0:
        print(f"[WARN] Command returned {p.returncode}: {cmd}")
    return p.returncode

def main():
    print("=" * 60)
    print("       Linkey 全套客户端与安装包一键生成器")
    print("=" * 60)

    csc = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if not os.path.exists(csc):
        csc = r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"

    os.makedirs(DIST, exist_ok=True)

    # 1. Icon
    print("\n[1/6] 正在生成高清多尺寸图标 app.ico ...")
    run_cmd(f'"{sys.executable}" scripts/generate_app_ico.py')

    # 2. 服务端管理系统 (托盘守护管理器)
    print("\n[2/6] 正在编译后台管理软件 (dist/Linkey-服务端管理系统.exe) ...")
    run_cmd(f'"{csc}" /nologo /target:winexe /win32icon:app.ico /out:"{DIST}\\Linkey-服务端管理系统.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll /reference:System.dll /reference:System.Web.Extensions.dll src_manager\\FastQQServerManager.cs')

    # 3. 桌面客户端 (浏览器 App 壳)
    print("\n[3/6] 正在编译 Windows 桌面客户端 (dist/Linkey.exe) ...")
    run_cmd(f'"{csc}" /nologo /target:winexe /win32icon:app.ico /out:"{DIST}\\Linkey.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll /reference:System.dll src_client\\FastQQClient.cs')

    # 4. 一键安装程序
    print("\n[4/6] 正在编译 Windows 一键安装程序 (dist/Linkey-安装程序.exe) ...")
    run_cmd(f'"{csc}" /nologo /target:winexe /win32icon:app.ico /out:"{DIST}\\Linkey-安装程序.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll /reference:System.dll src_client\\FastQQInstaller.cs')

    # 5. Android APK (签名密钥持久化，保证覆盖升级)
    print("\n[5/6] 正在构建 Android 安卓手机安装包 ...")
    run_cmd(f'"{sys.executable}" scripts/build_android_apk.py "http://{get_lan_ip()}:3000" "Linkey-Android.apk"')
    if os.path.exists("Linkey-Android.apk"):
        shutil.copy("Linkey-Android.apk", f"{DIST}/Linkey-Android.apk")
        os.makedirs("public/downloads", exist_ok=True)
        shutil.copy("Linkey-Android.apk", "public/downloads/Linkey-Android.apk")
        os.remove("Linkey-Android.apk")

    # 6. 打包分发包（单平台 zip 直接进网页下载目录，dist 只保留双端合集）
    print("\n[6/6] 正在打包所有分发安装包 ...")
    run_cmd(f'"{sys.executable}" scripts/package_dist.py')

    ip = get_lan_ip()
    print("\n" + "=" * 60)
    print("全套安装包已生成完毕！")
    print("dist/ 目录（本机保留的最终产物）:")
    print("  Linkey-服务端管理系统.exe   (后台管理软件，双击常驻托盘)")
    print("  Linkey.exe                  (电脑版客户端，绿色免安装)")
    print("  Linkey-安装程序.exe          (电脑版一键安装向导)")
    print("  Linkey-Android.apk          (安卓安装包，v1+v2 双签名)")
    print("  Linkey-全平台安装包.zip      (发给朋友的单文件合集)")
    print("  Linkey-全新服务器迁移包.zip   (换电脑部署全新空服务器)")
    print(f"\n网页下载地址 (局域网朋友可直接下载): http://{ip}:3000/downloads/")
    print("=" * 60)

if __name__ == '__main__':
    main()
