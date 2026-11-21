"""Cove Server for Windows and Mac. Same engine as the Docker image (cove-api + front.py), no Docker, no nginx.

    CoveServer.exe                 run in this window (Ctrl+C stops it)
    CoveServer.exe install         Windows: install as a service that starts with Windows (run as administrator)
    CoveServer.exe remove          Windows: remove the service
    CoveServer.exe setup-code      show the one-time setup code
    CoveServer.exe open            open Cove in the browser
    cove_server agent              keep it running with the log in the data folder (cove-server.log); the Mac
                                   LaunchAgent runs this (Nov 21, 2026, asked for by the Mac build chat)

Data (settings, keys, people) lives in:
    Windows  C:\\ProgramData\\Cove Server
    Mac      ~/Library/Application Support/Cove Server
The port is 5050 unless the data folder's server.json says otherwise ({"port": 5050}).
"""
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser

APP = "Cove Server"
FROZEN = getattr(sys, "frozen", False)
BUNDLE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def data_dir():
    if os.environ.get("COVE_DATA"):
        return os.environ["COVE_DATA"]
    if sys.platform == "win32":
        return os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), APP)
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/" + APP)
    return os.path.expanduser("~/.local/share/cove-server")


def settings():
    try:
        return json.load(open(os.path.join(data_dir(), "server.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def port():
    return int(os.environ.get("COVE_PORT") or settings().get("port") or 5050)


def files(name):
    """Bundled folders: next to the exe when built, or the repository's own folders when run from source."""
    p = os.path.join(BUNDLE, name)
    if os.path.isdir(p):
        return p
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return {"web": os.path.join(repo, "src", "web"), "books": os.path.join(repo, "src", "books"),
            "setup": os.path.join(repo, "setup"), "api": os.path.join(repo, "src", "api")}[name]


def env():
    e = dict(os.environ, COVE_FRONT="1", COVE_DATA=data_dir(), COVE_PORT=str(port()),
             COVE_HOST=settings().get("listen", "0.0.0.0"),
             COVE_WEB=files("web"), COVE_BOOKS=files("books"), COVE_SETUP=files("setup"),
             PYTHONUNBUFFERED="1")
    return e


# ------------------------------------------------------------------ the server itself (child process)
def serve():
    os.environ.update(env())
    os.makedirs(data_dir(), exist_ok=True)
    sys.path.insert(0, files("api"))
    import server      # noqa: E402  (cove-api; reads COVE_* when imported)
    server.main()


# ------------------------------------------------------------------ keeper: runs the server, starts it again if it stops
class Keeper:
    def __init__(self, log_to_file):
        self.stop = threading.Event()
        self.child = None
        self.log_to_file = log_to_file

    def _log(self):
        if not self.log_to_file:
            return None
        os.makedirs(data_dir(), exist_ok=True)
        p = os.path.join(data_dir(), "cove-server.log")
        if os.path.exists(p) and os.path.getsize(p) > 5 * 1024 * 1024:
            os.replace(p, p + ".old")
        return open(p, "ab")

    def run(self):
        cmd = [sys.executable, "serve"] if FROZEN else [sys.executable, os.path.abspath(__file__), "serve"]
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" and self.log_to_file else 0
        fast = 0
        while not self.stop.is_set():
            out = self._log()
            started = time.time()
            self.child = subprocess.Popen(cmd, env=env(), stdout=out or None, stderr=subprocess.STDOUT if out else None,
                                          creationflags=flags)
            while self.child.poll() is None and not self.stop.is_set():
                time.sleep(0.5)
            if self.stop.is_set():
                break
            fast = fast + 1 if time.time() - started < 10 else 0     # crashing at start over and over: slow down
            time.sleep(min(30, 1 + fast * 3))
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(10)
            except subprocess.TimeoutExpired:
                self.child.kill()


def setup_code():
    try:
        return open(os.path.join(data_dir(), "setup-code.txt")).read().strip()
    except OSError:
        return None


# ------------------------------------------------------------------ Windows service
if sys.platform == "win32":
    try:
        import servicemanager
        import win32service
        import win32serviceutil

        class CoveService(win32serviceutil.ServiceFramework):
            _svc_name_ = "CoveServer"
            _svc_display_name_ = "Cove Server"
            _svc_description_ = "Cove: one place for the family's movies, shows, books and requests. http://localhost:5050"

            def __init__(self, args):
                super().__init__(args)
                self.keeper = Keeper(log_to_file=True)

            def SvcStop(self):
                self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
                self.keeper.stop.set()

            def SvcDoRun(self):
                servicemanager.LogInfoMsg("Cove Server starting on port %d" % port())
                self.keeper.run()
    except ImportError:
        CoveService = None


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "run"
    if arg == "serve":
        return serve()
    if arg == "setup-code":
        print(setup_code() or "No setup code: this Cove Server is already set up (or hasn't started yet).")
        return
    if arg == "open":
        webbrowser.open("http://localhost:%d" % port())
        return
    if sys.platform == "win32" and arg in ("install", "remove", "start", "stop", "restart", "update", "debug") or arg == "--service":
        if CoveService is None:
            sys.exit("The Windows service part isn't in this build.")
        if arg == "--service" or (len(sys.argv) == 1 and FROZEN and not sys.stdout):
            servicemanager.Initialize()
            servicemanager.PrepareToHostSingle(CoveService)
            servicemanager.StartServiceCtrlDispatcher()
            return
        if arg == "install":
            # start with Windows, and come back by itself if it ever stops
            sys.argv = [sys.argv[0], "--startup", "auto", "install"]
            win32serviceutil.HandleCommandLine(CoveService, argv=sys.argv)
            subprocess.run(["sc", "failure", "CoveServer", "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/30000"],
                           capture_output=True)
            subprocess.run(["sc", "config", "CoveServer", "binPath=", '"%s" --service' % sys.executable], capture_output=True)
            win32serviceutil.StartService("CoveServer")
            print("Cove Server is installed and running: http://localhost:%d" % port())
            return
        return win32serviceutil.HandleCommandLine(CoveService)
    if arg == "agent":
        k = Keeper(log_to_file=True)
        import signal
        signal.signal(signal.SIGTERM, lambda *_: k.stop.set())    # launchd stops it with SIGTERM
        try:
            k.run()
        except KeyboardInterrupt:
            k.stop.set()
        return
    # run in this window
    print("Cove Server: http://localhost:%d   (data in %s)   Ctrl+C stops it" % (port(), data_dir()), flush=True)
    k = Keeper(log_to_file=False)
    try:
        k.run()
    except KeyboardInterrupt:
        k.stop.set()


if __name__ == "__main__":
    main()
