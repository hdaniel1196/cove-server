"""Cove Server tray icon (Windows; the Mac version gets a menu bar app). Starts at sign-in, shows whether the server is
running, opens Cove, shows the setup code on a new server, and opens the data folder. Quitting the tray icon doesn't stop
the server: that runs as a Windows service."""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

import pystray
from PIL import Image, ImageDraw

APP = "Cove Server"
DATA = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), APP)


def port():
    try:
        return int(json.load(open(os.path.join(DATA, "server.json"))).get("port") or 5050)
    except (OSError, ValueError):
        return 5050


def status():
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/cove-api/setup/status" % port(), timeout=3) as r:
            return "running" if json.load(r).get("done") else "setup"
    except Exception:
        return "down"


def mark(color=(95, 212, 232), tile=(17, 20, 28)):
    """Cove's bay-with-a-wave mark on its dark tile, drawn at 4x and scaled down for smooth edges."""
    s = 256
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([8, 8, s - 8, s - 8], radius=64, fill=tile)
    d.arc([52, 52, s - 52, s - 52], start=40, end=320, fill=color, width=20)
    pts = []
    for i in range(0, 41):
        x = 92 + i * 1.9
        y = 138 + 10 * __import__("math").sin(i / 40 * 2 * 3.14159)
        pts.append((x, y))
    d.line(pts, fill=color, width=18, joint="curve")
    return im.resize((64, 64), Image.LANCZOS)


ICONS = {"running": mark(), "setup": mark((229, 180, 84)), "down": mark((122, 130, 150))}
TEXT = {"running": "Cove Server is running", "setup": "Cove Server: waiting for setup", "down": "Cove Server isn't running"}


def show_code(icon=None, item=None):
    try:
        code = open(os.path.join(DATA, "setup-code.txt")).read().strip()
        msg = "Your setup code is:\n\n%s\n\nOpen Cove and type it on the setup page." % code
    except OSError:
        msg = "This Cove Server is already set up, so there's no setup code."
    ctypes.windll.user32.MessageBoxW(0, msg, APP, 0x40)


def main():
    state = {"s": status()}

    def menu_items():
        return (
            pystray.MenuItem(lambda _: TEXT[state["s"]], None, enabled=False),
            pystray.MenuItem("Open Cove", lambda: webbrowser.open("http://localhost:%d" % port()), default=True),
            pystray.MenuItem("Show setup code", show_code, visible=lambda _: state["s"] == "setup"),
            pystray.MenuItem("Open data folder", lambda: os.startfile(DATA) if os.path.isdir(DATA) else None),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Hide this icon", lambda icon, _: icon.stop()),
        )

    icon = pystray.Icon("CoveServer", ICONS[state["s"]], TEXT[state["s"]], pystray.Menu(*menu_items()))

    def watch():
        while True:
            time.sleep(10)
            s = status()
            if s != state["s"]:
                state["s"] = s
                icon.icon, icon.title = ICONS[s], TEXT[s]
                icon.update_menu()

    threading.Thread(target=watch, daemon=True).start()
    if state["s"] == "setup":
        threading.Timer(2, lambda: webbrowser.open("http://localhost:%d" % port())).start()   # first run: straight to setup
    icon.run()


if __name__ == "__main__":
    main()
