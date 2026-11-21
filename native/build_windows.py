"""Build Cove Server for Windows: CoveServer.exe (server + service) and CoveTray.exe (tray icon), plus the install and
uninstall scripts, zipped as "Cove Server for Windows <version>.zip" in dist\\.
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src")
BUILD = os.path.join(HERE, "build")
DIST = os.path.join(HERE, "dist")
PY = sys.executable


def run(*a):
    subprocess.run(a, check=True, cwd=HERE)


def check_scripts():
    """Every .ps1 has to parse in Windows PowerShell 5 (what Windows runs them with). A stray bracket once made
    install.ps1 close instantly without installing anything."""
    for n in ("install.ps1", "uninstall.ps1"):
        f = os.path.join(HERE, "windows", n)
        cmd = ("$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%s',[ref]$null,[ref]$e); "
               "if($e){$e|%%{$_.Message+' line '+$_.Extent.StartLineNumber}; exit 1}") % f
        r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", cmd], capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"{n} doesn't parse in Windows PowerShell: {r.stdout.strip()}")
    print("install scripts parse in Windows PowerShell")


def main():
    check_scripts()
    # same code as the Docker image: build.py copies Cove's web + api and Folio's web into ..\src
    version = re.search(r'COVE_VERSION = "([^"]+)"', open(os.path.join(SRC, "api", "server.py"), encoding="utf-8").read()).group(1)
    from PIL import Image
    sys.path.insert(0, HERE)
    import cove_tray
    ico = os.path.join(BUILD, "cove.ico")
    os.makedirs(BUILD, exist_ok=True)
    cove_tray.mark().resize((256, 256)).save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    sep = ";"
    common = ["--noconfirm", "--clean", "--onefile", "--icon", ico, "--distpath", os.path.join(BUILD, "out"),
              "--workpath", os.path.join(BUILD, "work"), "--specpath", BUILD]
    run(PY, "-m", "PyInstaller", *common, "--console", "--name", "CoveServer",
        "--paths", os.path.join(SRC, "api"), "--hidden-import", "server", "--hidden-import", "front", "--hidden-import", "passkeys",
        "--hidden-import", "win32timezone",
        "--add-data", f"{os.path.join(SRC, 'web')}{sep}web", "--add-data", f"{os.path.join(SRC, 'books')}{sep}books",
        "--add-data", f"{os.path.join(ROOT, 'setup')}{sep}setup", "--add-data", f"{os.path.join(SRC, 'api')}{sep}api",
        os.path.join(HERE, "cove_server.py"))
    run(PY, "-m", "PyInstaller", *common, "--windowed", "--name", "CoveTray", os.path.join(HERE, "cove_tray.py"))
    os.makedirs(DIST, exist_ok=True)
    z = os.path.join(DIST, f"Cove Server for Windows {version}.zip")
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as f:
        for n in ("CoveServer.exe", "CoveTray.exe"):
            f.write(os.path.join(BUILD, "out", n), f"Cove Server/{n}")
        for n in ("Install Cove Server.cmd", "install.ps1", "Uninstall Cove Server.cmd", "uninstall.ps1", "READ ME.txt"):
            f.write(os.path.join(HERE, "windows", n), f"Cove Server/{n}")
    print("built", z, round(os.path.getsize(z) / 1e6, 1), "MB")


if __name__ == "__main__":
    main()
