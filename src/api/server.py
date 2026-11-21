"""cove-api: Cove's small helper (Nov 18, 2026). Behind Cove's nginx at /cove-api/.

POST /cove-api/image   (Jellyfin admins only)
    {"itemId": "<jellyfin id>", "type": "Primary|Logo|Thumb|Banner|Disc|Art|Backdrop", "index": 0,
     "url": "<remote image url>" | "data": "<base64>", "contentType": "image/jpeg" | "delete": true}
  Saves the picture through EMBY, which writes it next to the media file (poster.jpg, fanart.jpg, clearlogo.png...),
  so Emby and Jellyfin both read the same file. Then Jellyfin is told to re-read that item's pictures.
  If the item isn't in Emby, answers {"emby": false} and Cove saves it in Jellyfin only.
POST /cove-api/saga/sync  {"id": "<playlist id>"}   (any signed-in user)
  Repairs a saga after Sonarr/Radarr replaced a file (new Jellyfin item id): puts the new copy back in the same spot.
  Answers {"repaired": [{"old", "new", "name"}]} so Cove can carry the watched mark over. Snapshots in /data/sagas.
GET  /cove-api/seerr/search?q=   GET /cove-api/seerr/tv?id=<tmdb>   GET /cove-api/seerr/requests
POST /cove-api/seerr/request  {"mediaType": "movie|tv", "tmdbId": 1, "quality": "hd|4k", "seasons": "all"|[1,2]}
  Movies: HD = Radarr profile "Standard", 4K = "Ultra-HD". Seerr's key is read from its own settings (volume, read-only).
POST /cove-api/tags  {"ids": [...], "add": ["Christmas"], "remove": []}   (Jellyfin admins)
  Adds/removes tags on movies, shows or episodes in Jellyfin (Tags field locked) and in Emby, so both match.
POST /cove-api/login  {"login": "<email or account name>", "password": "..."}   (no sign-in needed)
  Finds the Jellyfin account for an email in /data/people.json and signs in through Jellyfin (password passed through,
  never stored or logged). Answers Jellyfin's sign-in result plus "CoveRole" (owner|admin|member|kid).
GET  /cove-api/me   -> {"name", "role", "hasEmail"}
POST /cove-api/markers  {"itemId", "segments": [{type,start,end}], "note", "send": true, "clear": false}   (admins)
POST /cove-api/passkey/{register/options, register/verify, list, remove}   (signed in)   Face ID setup, passkeys.py
POST /cove-api/passkey/{login/options, login/verify}   (no sign-in)   Face ID sign-in: approves the device's Quick Connect code
GET  /cove-api/people   (owner/admin)   POST /cove-api/people/{add, setup, role, history, books, invite}   (owner)
  People page: add someone (email = their sign-in name), set them up with a starting password (creates the Jellyfin
  account and applies the level), change level, copy watch history from their Emby account.
POST /cove-api/people/invite {email} (owner) -> one-time code; GET/POST /cove-api/join (no sign-in): pick your own password
GET /cove-api/health

Python stdlib only. The Emby API key is read from a mounted file and never logged or returned.
The caller's own Jellyfin login is checked on every call (GET /Users/Me, must be an administrator).
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import passkeys

# ------------------------------------------------------------------ Cove Server settings (Nov 20, 2026, phase 1 of the
COVE_VERSION = "0.3.0"
import os
# Folders (Nov 20, 2026): Docker uses /data; the Windows service and the Mac app set COVE_DATA to their own folder.
DATA = os.environ.get("COVE_DATA", "/data")
D = lambda *p: os.path.join(DATA, *p)
CONFIG_F = D("cove-config.json")
# Every request Cove makes says it's Cove Server (Nov 21, 2026): Cloudflare blocks the default "Python-urllib" label with
_opener = urllib.request.build_opener()
_opener.addheaders = [("User-Agent", "CoveServer/%s" % COVE_VERSION)]
urllib.request.install_opener(_opener)


def _load_config():
    try:
        c = json.load(open(CONFIG_F, encoding="utf-8"))
    except (OSError, ValueError):
        c = {}
    srv = c.setdefault("server", {})
    if not srv.get("id"):               # stable id, so apps know it's the same server at a new address
        import uuid
        srv["id"] = uuid.uuid4().hex
        try:
            tmp = CONFIG_F + ".tmp"
            json.dump(c, open(tmp, "w", encoding="utf-8"), indent=2)
            import os as _os
            _os.replace(tmp, CONFIG_F)
        except OSError:
            pass
    return c


def _read_key(path):
    try:
        return open(path).read().strip() if path else ""
    except OSError:
        return ""


CONFIG = _load_config()
_svc = lambda k: CONFIG.get(k) or {}
JF = _svc("video").get("url", "http://jellyfin:8096")
EMBY = _svc("history").get("url", "")
EMBY_KEY = _read_key(_svc("history").get("keyFile", ""))
passkeys.RP_ID = _svc("passkeys").get("rpId", passkeys.RP_ID)
passkeys.ORIGINS = set(_svc("passkeys").get("origins") or passkeys.ORIGINS)


# make the choice for each one in general. like cinema has the choice for emby, plex, or jellyfin etc. right at the top")
# Only the ones Cove can really talk to are pickable; the rest show as coming. Folio, Vinyl and Requests can be off.
PART_SERVICES = [
    {"part": "reel", "name": "Cinema", "key": "video", "canOff": False,
     "options": [("jellyfin", "Jellyfin", True), ("emby", "Emby", False), ("plex", "Plex", False)]},
    {"part": "folio", "name": "Folio", "key": "books", "canOff": True,
     "options": [("kavita", "Kavita", True), ("komga", "Komga", False), ("audiobookshelf", "Audiobookshelf", False)]},
    {"part": "vinyl", "name": "Vinyl", "key": "music", "canOff": True,
     "options": [("jellyfin", "Jellyfin music", False), ("navidrome", "Navidrome", False), ("plex", "Plex", False)]},
    {"part": "requests", "name": "Requests", "key": "requests", "canOff": True,
     "options": [("seerr", "Seerr", True)]},
]
HEALTH = {"jellyfin": "/System/Info/Public", "kavita": "/api/health", "seerr": "/status"}


def part_off(key):
    c = CONFIG.get(key) or {}
    return bool(c.get("off")) or not c.get("type")


def services_info():
    out = []
    for d in PART_SERVICES:
        c = CONFIG.get(d["key"]) or {}
        cur = "off" if part_off(d["key"]) else c.get("type")
        ok = None
        if cur in HEALTH and c.get("url"):
            base = c["url"][:-len("/api/v1")] if cur == "seerr" and c["url"].endswith("/api/v1") else c["url"]
            try:
                http(base + (HEALTH[cur] if cur != "seerr" else "/api/v1/status"), timeout=5, raw=True)
                ok = True
            except Exception:
                ok = False
        out.append({"part": d["part"], "name": d["name"], "current": cur, "canOff": d["canOff"], "reachable": ok,
                    "address": c.get("url") if cur != "off" else None, "savedAddress": c.get("url"),
                    "service": {"video": "jellyfin", "books": "kavita", "requests": "seerr"}.get(d["key"]),
                    "editable": FRONT and d["key"] in ("video", "books", "requests"),
                    "options": [{"id": i, "name": n, "ready": r} for i, n, r in d["options"]]})
    return {"parts": out}


def services_set(req):
    d = next((x for x in PART_SERVICES if x["part"] == req.get("part")), None)
    if not d:
        raise ValueError("unknown part")
    choice = req.get("provider")
    c = CONFIG.setdefault(d["key"], {})
    if choice == "off":
        if not d["canOff"]:
            raise ValueError(f"{d['name']} can't be turned off")
        c["off"] = True
    else:
        opt = next((o for o in d["options"] if o[0] == choice), None)
        if not opt:
            raise ValueError("unknown service")
        if not opt[2]:
            raise ValueError(f"{opt[1]} isn't supported yet")
        if not c.get("url"):
            raise ValueError(f"No address set for {opt[1]} yet")
        c["type"] = choice
        c.pop("off", None)
    tmp = CONFIG_F + ".tmp"
    json.dump(CONFIG, open(tmp, "w", encoding="utf-8"), indent=2)
    os.replace(tmp, CONFIG_F)
    return services_info()


def server_info():
    """GET /cove-api/server-info (no sign-in): what this Cove Server is and offers, for the apps' pairing."""
    srv = CONFIG.get("server", {})
    try:
        code = bool(http(JF + "/QuickConnect/Enabled", timeout=5))
    except Exception:
        code = False
    books = bool(_svc("books").get("url")) and not part_off("books")
    return {"name": srv.get("name", "Cove"), "version": COVE_VERSION, "serverId": srv.get("id"),
            "connected": {"video": _svc("video").get("type"), "books": books, "requests": bool(_svc("requests").get("url")) and not part_off("requests"),
                          "liveTV": bool(CONFIG.get("liveTv")), "music": False},
            "signIn": {"password": True, "code": code, "faceId": bool(passkeys.RP_ID), "rpId": passkeys.RP_ID, "pin": True},
            "addresses": {"local": srv.get("localUrl"), "public": srv.get("publicUrl")},
            "reportsTo": srv.get("reportsTo") or None,
            "minAppVersion": srv.get("minAppVersion", "0.1")}
TYPES = {"Primary", "Logo", "Thumb", "Banner", "Disc", "Art", "Backdrop"}


def http(url, method="GET", body=None, headers=None, raw=False, timeout=60):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        t = r.read()
        return t if raw else (json.loads(t) if t else None)


def emby(path, method="GET", query=None, body=None, headers=None):
    q = dict(query or {})
    q["api_key"] = EMBY_KEY
    return http(f"{EMBY}{path}?{urllib.parse.urlencode(q)}", method, body, headers)


def jf(path, auth, method="GET", query=None, body=None):
    url = JF + path + ("?" + urllib.parse.urlencode(query) if query else "")
    return http(url, method, body, {"Authorization": auth})


def emby_path(p):
    mf = _svc("history").get("mediaFolder")
    return (mf.rstrip("\\") + "\\" + p[len("/media/"):].replace("/", "\\")) if mf and p and p.startswith("/media/") else None


def _norm(p):
    return (p or "").replace("/", "\\").rstrip("\\").lower()


def _folder(p):
    p = _norm(p)
    return p.rsplit("\\", 1)[0] if "\\" in p else p


def find_emby(item):
    """Same item in Emby. Movies and episodes match on their folder (a Radarr/Sonarr upgrade renames the file,
    and Jellyfin may not have rescanned yet); episodes also need the same season and episode number."""
    want = _norm(emby_path(item.get("Path")))
    if not want:
        return None
    kind = item.get("Type")
    by_folder = kind in ("Movie", "Episode")
    target = _folder(want) if by_folder else want

    def same(i):
        p = _norm(i.get("Path"))
        if (_folder(p) if by_folder else p) != target:
            return False
        if kind == "Episode":
            return (i.get("ParentIndexNumber"), i.get("IndexNumber")) == (item.get("ParentIndexNumber"), item.get("IndexNumber"))
        return True

    tried = []
    for k in ("Imdb", "Tmdb", "Tvdb"):
        v = (item.get("ProviderIds") or {}).get(k)
        if v:
            tried.append({"AnyProviderIdEquals": f"{k.lower()}.{v}"})
    tried.append({"SearchTerm": item.get("Name", "")})
    for q in tried:
        d = emby("/Items", query={"Recursive": "true", "IncludeItemTypes": kind, "Fields": "Path", **q})
        for i in d.get("Items", []):
            if same(i):
                return i["Id"]
    return None


# ------------------------------------------------------------------ saga repair
# A saga is a Jellyfin playlist. When Sonarr/Radarr replace a file, Jellyfin gives the new file a NEW item id and the
# old playlist entry vanishes. We keep a snapshot of each saga (what every entry IS: show + season + episode, or the
# movie's TMDb/IMDb id) and, on sync, put the new copy back in the same spot. An entry whose old item still exists was
# removed on purpose, so it stays removed.
import os
import re as _re
import hashlib
import hmac
SAGA_DIR = D("sagas")
os.makedirs(SAGA_DIR, exist_ok=True)


def _title(name):
    name = _re.sub(r"^.*?\s-\s(?:S\d+)?E\d{1,4}\s-\s", "", name or "", flags=_re.I)
    return _re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def saga_key(i):
    if i.get("Type") == "Episode":
        if i.get("ParentIndexNumber") is not None and i.get("IndexNumber") is not None:
            return f"ep|{i.get('SeriesId')}|{i['ParentIndexNumber']}|{i['IndexNumber']}"
        return f"epn|{i.get('SeriesId')}|{_title(i.get('Name'))}"
    p = i.get("ProviderIds") or {}
    for k in ("Tmdb", "Imdb", "Tvdb"):
        if p.get(k):
            return f"mv|{k}|{p[k]}"
    return f"name|{i.get('Type')}|{_title(i.get('Name'))}"


def find_by_key(key, name, auth, uid):
    parts = key.split("|")
    try:
        if parts[0] in ("ep", "epn"):
            eps = jf(f"/Shows/{parts[1]}/Episodes", auth, query={"userId": uid}).get("Items", [])
            for e in eps:
                if parts[0] == "ep" and str(e.get("ParentIndexNumber")) == parts[2] and str(e.get("IndexNumber")) == parts[3]:
                    return e["Id"]
                if parts[0] == "epn" and _title(e.get("Name")) == parts[2]:
                    return e["Id"]
            return None
        typ = "Movie" if parts[0] == "mv" else parts[1]
        d = jf("/Items", auth, query={"userId": uid, "recursive": "true", "includeItemTypes": typ,
                                       "searchTerm": name or "", "fields": "ProviderIds", "limit": "50"})
        for i in d.get("Items", []):
            if saga_key(i) == key:
                return i["Id"]
    except urllib.error.HTTPError:
        pass
    return None


# other people be able to make sagas. and it can mix tv shows and movies. and the owner and admins can edit people's
# sagas. but members can only edit their own. admins and owners can make it public to everyone else if needed.")
# Jellyfin only lets a playlist's owner change it (even the server key is refused), so cove-api makes the change AS the
# owner: it approves a Quick Connect code for them (like Face ID sign-in) and keeps that token. Owner and the public flag
# come from playlist.xml (Jellyfin's own file, mounted read-only at /jfplaylists).
_owner_tokens = {}


def _jf_key():
    return _read_key(_svc("video").get("keyFile", "/secrets/jellyfin_api_key.txt"))


def key_auth():
    return f'MediaBrowser Token="{_jf_key()}"'


def owner_auth(uid):
    """A Jellyfin token for this user, made with Quick Connect (device "Cove helper, saga editing")."""
    tok = _owner_tokens.get(uid)
    if tok:
        try:
            jf("/Users/Me", f'MediaBrowser Token="{tok}"')
            return f'MediaBrowser Token="{tok}"'
        except Exception:
            _owner_tokens.pop(uid, None)
    client = f'MediaBrowser Client="Cove helper", Device="Saga editing", DeviceId="cove-saga-{uid}", Version="1"'
    start = http(f"{JF}/QuickConnect/Initiate", "POST", b"", {"Authorization": client})
    http(f"{JF}/QuickConnect/Authorize?code={start['Code']}&userId={uid}", "POST", b"", {"Authorization": key_auth()})
    done = http(f"{JF}/Users/AuthenticateWithQuickConnect", "POST", {"Secret": start["Secret"]}, {"Authorization": client})
    _owner_tokens[uid] = done["AccessToken"]
    return f'MediaBrowser Token="{done["AccessToken"]}"'


PLAYLISTS = os.environ.get("COVE_PLAYLISTS", "/jfplaylists")


def playlist_meta():
    """{folder name: {"owner": user id, "public": bool}} from Jellyfin's playlist.xml files."""
    out = {}
    try:
        names = os.listdir(PLAYLISTS)
    except OSError:
        return out
    for n in names:
        try:
            x = open(os.path.join(PLAYLISTS, n, "playlist.xml"), encoding="utf-8-sig").read()
        except OSError:
            continue
        o = _re.search(r"<OwnerUserId>([^<]+)</OwnerUserId>", x)
        pub = _re.search(r"<OpenAccess>([^<]+)</OpenAccess>", x)
        out[n] = {"owner": (o.group(1).replace("-", "").lower() if o else None), "public": bool(pub and pub.group(1).strip().lower() == "true")}
    return out


_public_cache = {}


def saga_public(sid, owner):
    """Jellyfin keeps "public" (OpenAccess) in its database, not in playlist.xml, so ask it as the owner (cached 60 s)."""
    c = _public_cache.get(sid)
    if c and time.time() - c[1] < 60:
        return c[0]
    try:
        v = bool(jf(f"/Playlists/{sid}", owner_auth(owner)).get("OpenAccess")) if owner and owner.strip("0") else False
    except Exception:
        v = False
    _public_cache[sid] = (v, time.time())
    return v


def saga_meta(sid):
    found = jf("/Items", key_auth(), query={"ids": sid, "fields": "Path", "recursive": "true"}).get("Items", [])
    if not found:
        raise ValueError("That saga is gone")
    it = found[0]
    folder = os.path.basename((it.get("Path") or "").rstrip("/"))
    m = dict(playlist_meta().get(folder, {"owner": None}))
    m["public"] = saga_public(sid, m.get("owner"))
    return it, m


def saga_list(uid, role):
    items = jf("/Items", key_auth(), query={"recursive": "true", "includeItemTypes": "Playlist", "fields": "ChildCount,Path,DateCreated",
                                            "sortBy": "SortName"}).get("Items", [])
    meta = playlist_meta()
    names = {u["Id"]: u["Name"] for u in jf("/Users", key_auth())}
    admin = LEVELS.get(role, 2) >= LEVELS["admin"]
    out = []
    for i in items:
        if i.get("MediaType") not in (None, "Video", "Unknown"):
            continue
        m = meta.get(os.path.basename((i.get("Path") or "").rstrip("/")), {})
        owner = m.get("owner")
        mine = owner == uid
        m = {**m, "public": saga_public(i["Id"], owner)}
        if not (mine or m.get("public") or admin):
            continue
        out.append({"id": i["Id"], "name": i.get("Name"), "owner": {"id": owner, "name": names.get(owner, "?")}, "public": bool(m.get("public")),
                    "mine": mine, "canEdit": mine or admin, "count": i.get("ChildCount"), "created": i.get("DateCreated"),
                    "imageTags": i.get("ImageTags") or {}})
    return {"sagas": out, "canCreate": LEVELS.get(role, 2) >= LEVELS["member"], "canPublish": admin}


def saga_create(body, auth, uid, role):
    if LEVELS.get(role, 2) < LEVELS["member"]:
        raise PermissionError("Sagas are made by members and up")
    name = (body.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("Give it a name")
    r = jf("/Playlists", auth, "POST", body={"Name": name, "Ids": [str(x) for x in body.get("ids") or []], "UserId": uid, "MediaType": "Video", "IsPublic": False})   # Jellyfin defaults to public
    return {"id": r.get("Id")}


def saga_edit(body, uid, role):
    sid = str(body.get("id") or "")
    op = body.get("op")
    it, m = saga_meta(sid)
    if it.get("Type") != "Playlist":
        raise ValueError("not a saga")
    admin = LEVELS.get(role, 2) >= LEVELS["admin"]
    owner = m.get("owner")
    if not (owner == uid or admin):
        raise PermissionError("Only the person who made it (or an admin) can change this saga")
    if not owner:
        raise ValueError("Can't tell who owns this saga")
    a = owner_auth(owner)
    if op == "add":
        ids = [str(x) for x in body.get("ids") or []]
        if ids:
            jf(f"/Playlists/{sid}/Items", a, "POST", query={"ids": ",".join(ids), "userId": owner}, body=b"")
    elif op == "remove":
        ids = [str(x) for x in body.get("entryIds") or []]
        if ids:
            jf(f"/Playlists/{sid}/Items", a, "DELETE", query={"entryIds": ",".join(ids)})
    elif op == "move":
        jf(f"/Playlists/{sid}/Items/{body['entryId']}/Move/{int(body['to'])}", a, "POST", body=b"")
    elif op == "rename":
        name = (body.get("name") or "").strip()[:80]
        if not name:
            raise ValueError("Give it a name")
        jf(f"/Playlists/{sid}", a, "POST", body={"Name": name})
    elif op == "public":
        if not admin:
            raise PermissionError("Only the owner or an admin can make a saga public")
        jf(f"/Playlists/{sid}", a, "POST", body={"IsPublic": bool(body.get("on"))})
        _public_cache.pop(sid, None)
    elif op == "delete":
        jf(f"/Items/{sid}", a, "DELETE")
        try:
            os.remove(os.path.join(SAGA_DIR, f"{sid}.json"))
        except OSError:
            pass
        return {"ok": True}
    else:
        raise ValueError("unknown change")
    if op in ("add", "remove", "move"):
        saga_snapshot(sid, a, owner)
    return {"ok": True}


def saga_items(sid, auth, uid):
    return jf(f"/Playlists/{sid}/Items", auth, query={"userId": uid, "fields": "ProviderIds"}).get("Items", [])


def saga_snapshot(sid, auth, uid):
    items = saga_items(sid, auth, uid)
    snap = [{"id": i["Id"], "key": saga_key(i), "name": i.get("Name")} for i in items]
    json.dump(snap, open(os.path.join(SAGA_DIR, f"{sid}.json"), "w", encoding="utf-8"), ensure_ascii=False)


def saga_sync(sid, auth, uid):
    path = os.path.join(SAGA_DIR, f"{sid}.json")
    items = saga_items(sid, auth, uid)
    repaired = []
    try:
        snap = json.load(open(path, encoding="utf-8"))
    except Exception:
        snap = None
    if snap:
        have = {i["Id"] for i in items}
        for pos, e in enumerate(snap):
            if e["id"] in have:
                continue
            try:                                   # old item still exists: removed on purpose
                jf(f"/Items/{e['id']}", auth, query={"userId": uid})
                continue
            except urllib.error.HTTPError as x:
                if x.code != 404:
                    continue
            new = find_by_key(e["key"], e.get("name"), auth, uid)
            if not new or new in have:
                continue
            jf(f"/Playlists/{sid}/Items", auth, "POST", query={"ids": new, "userId": uid}, body=b"")
            items = saga_items(sid, auth, uid)
            snap_pos = {x["id"]: n for n, x in enumerate(snap)}
            target = sum(1 for i in items if i["Id"] != new and snap_pos.get(i["Id"], 10**9) < pos)
            entry = next((i for i in items if i["Id"] == new), None)
            if entry and entry.get("PlaylistItemId"):
                jf(f"/Playlists/{sid}/Items/{entry['PlaylistItemId']}/Move/{target}", auth, "POST", body=b"")
                items = saga_items(sid, auth, uid)
            have.add(new)
            repaired.append({"old": e["id"], "new": new, "name": e.get("name")})
            print(f"saga {sid}: replaced {e.get('name')} -> {new}", flush=True)
    tmp = path + ".tmp"
    json.dump([{"id": i["Id"], "key": saga_key(i), "name": i.get("Name")} for i in items], open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, path)
    return repaired


# ------------------------------------------------------------------ requests through Seerr
# show's seasons, and follow requests with download progress. Requests go in AS the Cove user (Seerr X-API-User),
SEERR = _svc("requests").get("url", "")
TMDB_IMG = "https://image.tmdb.org/t/p/"
PROFILE_HD, PROFILE_4K = "Standard", "Ultra-HD"
_seerr_users = {"t": 0, "map": {}}


def seerr_key():
    c = _svc("requests")
    if c.get("keyFile"):
        return _read_key(c["keyFile"])
    return json.load(open(c.get("settingsFile", "/seerr/settings.json")))["main"]["apiKey"]


def seerr(path, method="GET", body=None, as_user=None, query=None):
    # Seerr rejects "+" for spaces, so encode them as %20
    url = SEERR + path + ("?" + urllib.parse.urlencode(query, quote_via=urllib.parse.quote) if query else "")
    h = {"X-Api-Key": seerr_key()}
    if as_user:
        h["X-API-User"] = str(as_user)
    return http(url, method, body, h)


def seerr_user(name):
    if time.time() - _seerr_users["t"] > 600:
        users = seerr("/user", query={"take": "200"}).get("results", [])
        m = {}
        for u in users:
            for k in ("displayName", "jellyfinUsername", "embyUsername", "plexUsername", "username"):
                if u.get(k):
                    m.setdefault(u[k].lower(), u["id"])
        _seerr_users.update(t=time.time(), map=m)
    n = (name or "").lower()
    return _seerr_users["map"].get(n)


STATUS = {1: "unknown", 2: "requested", 3: "downloading", 4: "partly here", 5: "here", 6: "deleted", 7: "blocked"}
REQ_STATUS = {1: "waiting for approval", 2: "approved", 3: "declined", 4: "failed", 5: "done"}


def slim(i):
    mi = i.get("mediaInfo") or {}
    date = i.get("releaseDate") or i.get("firstAirDate") or ""
    return {"mediaType": i.get("mediaType"), "tmdbId": i.get("id"), "title": i.get("title") or i.get("name"),
            "year": date[:4], "overview": i.get("overview"),
            "poster": TMDB_IMG + "w342" + i["posterPath"] if i.get("posterPath") else None,
            "backdrop": TMDB_IMG + "w1280" + i["backdropPath"] if i.get("backdropPath") else None,
            "status": STATUS.get(mi.get("status"), "unknown"), "rating": i.get("voteAverage")}


def progress(media):
    out = []
    for d in (media or {}).get("downloadStatus") or []:
        size, left = d.get("size") or 0, d.get("sizeLeft") or 0
        out.append({"title": d.get("title"), "pct": round(100 * (1 - left / size)) if size else 0,
                    "eta": d.get("estimatedCompletionTime"), "state": d.get("status")})
    return out


def seerr_requests(uid):
    d = seerr("/request", query={"take": "30", "skip": "0", "filter": "all", "sort": "added", "requestedBy": str(uid)})
    out = []
    for r in d.get("results", []):
        m = r.get("media") or {}
        kind = r.get("type") or m.get("mediaType")
        try:
            info = seerr(f"/{'movie' if kind == 'movie' else 'tv'}/{m.get('tmdbId')}")
            title, poster = info.get("title") or info.get("name"), info.get("posterPath")
        except Exception:
            title, poster = None, None
        out.append({"id": r["id"], "mediaType": kind, "tmdbId": m.get("tmdbId"), "title": title,
                    "poster": TMDB_IMG + "w342" + poster if poster else None, "is4k": r.get("is4k"),
                    "request": REQ_STATUS.get(r.get("status"), "?"), "status": STATUS.get(m.get("status"), "unknown"),
                    "progress": progress(m), "seasons": [x.get("seasonNumber") for x in r.get("seasons") or []],
                    "added": r.get("createdAt")})
    return out


def seerr_request(uid, req, approve=False):
    kind, tmdb = req.get("mediaType"), int(req.get("tmdbId") or 0)
    if kind not in ("movie", "tv") or not tmdb:
        raise ValueError("bad request")
    body = {"mediaType": kind, "mediaId": tmdb}
    if kind == "movie":
        prof = seerr("/service/radarr/0")
        want = PROFILE_4K if req.get("quality") == "4k" else PROFILE_HD
        pid = next((p["id"] for p in prof.get("profiles", []) if p["name"] == want), None)
        if pid:
            body.update({"serverId": 0, "profileId": pid})
    else:
        seasons = req.get("seasons")
        body["seasons"] = "all" if seasons in (None, "all") else [int(x) for x in seasons]
    r = seerr("/request", "POST", body, as_user=uid)
    status = r.get("status")
    if approve and status == 1:
        # owner and admins don't wait for anyone
        seerr(f"/request/{r['id']}/approve", "POST", body=b"")
        status = 2
    return {"id": r.get("id"), "status": REQ_STATUS.get(status, "?")}


# here to automatically approve?"). Uses Seerr's own permission bits, so it also covers requests made in Seerr itself.
AA_MOVIE, AA_TV, AA_4K = 256, 512, 32768
AA_ALL = 128 | 256 | 512 | 32768 | 65536 | 131072


def aa_flags(perm):
    perm = perm or 0
    return {"admin": bool(perm & 2), "movie": bool(perm & (128 | AA_MOVIE)), "tv": bool(perm & (128 | AA_TV)),
            "fourk": bool(perm & (AA_4K | 65536 | 131072))}


def aa_bits(perm, want):
    perm = (perm or 0) & ~AA_ALL
    return perm | (AA_MOVIE if want.get("movie") else 0) | (AA_TV if want.get("tv") else 0) | (AA_4K if want.get("fourk") else 0)


def autoapprove_get():
    users = seerr("/user", query={"take": "200"}).get("results", [])
    main = seerr("/settings/main")
    return {"default": aa_flags(main.get("defaultPermissions")),
            "users": [{"id": u["id"], "name": u.get("displayName") or u.get("username") or "?", **aa_flags(u.get("permissions"))} for u in users]}


def autoapprove_set(req):
    who = req.get("id")
    if who == "default":
        main = seerr("/settings/main")
        main["defaultPermissions"] = aa_bits(main.get("defaultPermissions"), req)
        seerr("/settings/main", "POST", main)
        return {"ok": True}
    uid = int(who)
    u = seerr(f"/user/{uid}")
    if (u.get("permissions") or 0) & 2:
        raise ValueError("Admins are always approved")
    seerr(f"/user/{uid}/settings/permissions", "POST", {"permissions": aa_bits(u.get("permissions"), req)})
    return {"ok": True}


def seerr_all_requests():
    """Everyone's requests, newest first (admins)."""
    d = seerr("/request", query={"take": "50", "skip": "0", "filter": "all", "sort": "added"})
    out = []
    for r in d.get("results", []):
        m = r.get("media") or {}
        kind = r.get("type") or m.get("mediaType")
        try:
            info = seerr(f"/{'movie' if kind == 'movie' else 'tv'}/{m.get('tmdbId')}")
            title, poster = info.get("title") or info.get("name"), info.get("posterPath")
        except Exception:
            title, poster = None, None
        out.append({"id": r["id"], "mediaType": kind, "tmdbId": m.get("tmdbId"), "title": title, "is4k": r.get("is4k"),
                    "by": (r.get("requestedBy") or {}).get("displayName") or "someone",
                    "poster": TMDB_IMG + "w342" + poster if poster else None,
                    "request": REQ_STATUS.get(r.get("status"), "?"), "status": STATUS.get(m.get("status"), "unknown"),
                    "progress": progress(m), "seasons": [x.get("seasonNumber") for x in r.get("seasons") or []], "added": r.get("createdAt")})
    return out


def seerr_pending():
    d = seerr("/request", query={"take": "50", "skip": "0", "filter": "pending", "sort": "added"})
    out = []
    for r in d.get("results", []):
        m = r.get("media") or {}
        kind = r.get("type") or m.get("mediaType")
        try:
            info = seerr(f"/{'movie' if kind == 'movie' else 'tv'}/{m.get('tmdbId')}")
            title, poster = info.get("title") or info.get("name"), info.get("posterPath")
        except Exception:
            title, poster = None, None
        who = (r.get("requestedBy") or {}).get("displayName") or "someone"
        out.append({"id": r["id"], "mediaType": kind, "title": title, "by": who, "is4k": r.get("is4k"),
                    "poster": TMDB_IMG + "w342" + poster if poster else None,
                    "seasons": [x.get("seasonNumber") for x in r.get("seasons") or []], "added": r.get("createdAt")})
    return out


def seerr_tv(tmdb):
    d = seerr(f"/tv/{int(tmdb)}")
    have = {x.get("seasonNumber"): STATUS.get(x.get("status"), "unknown") for x in (d.get("mediaInfo") or {}).get("seasons") or []}
    return [{"n": x["seasonNumber"], "name": x.get("name"), "episodes": x.get("episodeCount"),
             "status": have.get(x["seasonNumber"], "unknown")} for x in d.get("seasons", []) if x.get("seasonNumber")]


# ------------------------------------------------------------------ tags (Kids, Christmas, Filler, Canon, ...)
# A tag change is saved in Jellyfin (Tags locked so a metadata refresh can't drop them) AND in Emby, so Emby's
# Kids accounts keep matching until everyone moves to Cove.
def _clean_tags(tags):
    out = []
    for t in tags or []:
        t = " ".join(str(t).split())[:40]
        if t and t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out


def _edit(tags, add, remove):
    rm = {t.lower() for t in remove}
    cur = [t for t in tags if t.lower() not in rm]
    for t in add:
        if t.lower() not in {x.lower() for x in cur}:
            cur.append(t)
    return cur


def jf_set_tags(iid, auth, uid, add, remove):
    item = jf(f"/Items/{iid}", auth, query={"userId": uid})
    new = _edit(item.get("Tags") or [], add, remove)
    if new == (item.get("Tags") or []):
        return item, new, False
    item["Tags"] = new
    locked = set(item.get("LockedFields") or [])
    locked.add("Tags")
    item["LockedFields"] = sorted(locked)
    jf(f"/Items/{iid}", auth, "POST", body=item)
    return item, new, True


def emby_set_tags(item_for_match, add, remove):
    eid = find_emby(item_for_match)
    if not eid:
        return None
    users = emby("/Users")
    admin = next((u["Id"] for u in users if u.get("Policy", {}).get("IsAdministrator")), users[0]["Id"])
    e = emby(f"/Users/{admin}/Items/{eid}")
    cur = [t.get("Name") for t in e.get("TagItems") or []] or (e.get("Tags") or [])
    new = _edit(cur, add, remove)
    if new != cur:
        e["Tags"] = new
        e["TagItems"] = [{"Name": t} for t in new]
        emby(f"/Items/{eid}", "POST", body=e)
    return eid


def set_tags(ids, add, remove, auth, uid):
    add, remove = _clean_tags(add), _clean_tags(remove)
    done = []
    for iid in ids:
        if not str(iid).isalnum():
            continue
        item, new, changed = jf_set_tags(iid, auth, uid, add, remove)
        try:
            full = jf(f"/Items/{iid}", auth, query={"userId": uid, "fields": "Path,ProviderIds"})
            eid = emby_set_tags(full, add, remove)
        except Exception:
            eid = None
        done.append({"id": iid, "tags": new, "emby": bool(eid)})
    return done


# ------------------------------------------------------------------ people: sign in with email, roles
# /data/people.json = [{"email": "...", "user": "<Jellyfin user name>", "role": "owner|admin|member|kid"}]
# Sign-in: email (or the plain account name) + password -> cove-api finds the Jellyfin account -> Jellyfin checks the
# password as usual. The password is passed straight to Jellyfin and never stored or logged.
PEOPLE = D("people.json")
ROLES = ("owner", "admin", "member", "teen", "kid")


def people():
    try:
        return json.load(open(PEOPLE, encoding="utf-8"))
    except Exception:
        return []


# ------------------------------------------------------------------ which parts of Cove each person can use (Nov 20, 2026,
# saying to ask the owner for access to something"). people.json "parts": {"reel": bool, "folio": bool, "vinyl": bool};
# missing = on. Folio also needs a linked Kavita account; Vinyl needs music (not built yet). The owner always has all.
def parts_of(p):
    pt = (p or {}).get("parts") or {}
    owner = (p or {}).get("role") == "owner"
    return {"reel": owner or pt.get("reel", True),
            "folio": (owner or pt.get("folio", True)) and has_books(p) and not part_off("books"),
            "requests": (owner or (pt.get("requests", True) and (p or {}).get("role") not in ("kid", "teen"))) and not part_off("requests"),
            "vinyl": False}                     # music isn't connected yet; the switch is kept for when it is


def owner_name():
    return next((x.get("user") for x in people() if x.get("role") == "owner"), "the owner")


def people_parts(req, actor_role):
    lst, p = person_by_email(req.get("email"))
    if p.get("role") == "owner":
        raise ValueError("The owner always has everything")
    if p.get("role") == "admin" and actor_role != "owner":
        raise ValueError("Only the owner can change an admin")
    pt = dict(p.get("parts") or {})
    for k in ("reel", "folio", "vinyl", "requests"):
        if k in req:
            pt[k] = bool(req[k])
    reel_was = (p.get("parts") or {}).get("reel", True)
    p["parts"] = pt
    # Reel off really turns videos off in Jellyfin (their Jellyfin apps too), and on puts back what they had
    u = jf_users().get((p.get("user") or "").lower())
    if u and reel_was != pt.get("reel", True):
        pol = dict(u["Policy"])
        if not pt.get("reel", True):
            p["reelSaved"] = {k: pol.get(k) for k in ("EnableAllFolders", "EnabledFolders", "EnableMediaPlayback", "EnableLiveTvAccess")}
            pol.update({"EnableAllFolders": False, "EnabledFolders": [], "EnableMediaPlayback": False, "EnableLiveTvAccess": False})
        else:
            pol.update({k: v for k, v in (p.pop("reelSaved", None) or {"EnableAllFolders": True, "EnableMediaPlayback": True}).items() if v is not None})
        jf(f"/Users/{u['Id']}/Policy", jf_key_auth(), "POST", body=pol)
    save_people(lst)
    return {"ok": True, "parts": parts_of(p)}


def person_for(login):
    login = (login or "").strip().lower()
    for p in people():
        if login and login in ((p.get("email") or "").lower(), (p.get("user") or "").lower()):
            return p
    return None


# in a row for an account, the next try has to wait a minute. A right password clears it.
_fails = {}


class SlowDown(Exception):
    pass


# ------------------------------------------------------------------ Cove's own per-person settings (Nov 20, 2026)
# stuff". So Cove's settings live here, not inside one server: /data/prefs/<user id>/<store>.json, one file per store
# (sagas, watching, home, subs, play). Values are strings, same shape as Jellyfin's CustomPrefs, so moving over is 1:1.
PREFS_DIR = D("prefs")
PREF_STORES = {"sagas", "watching", "home", "subs", "play", "books"}


def prefs_path(uid, store):
    if store not in PREF_STORES or not _re.fullmatch(r"[0-9a-f]{32}", uid or ""):
        raise ValueError("unknown store")
    return os.path.join(PREFS_DIR, uid, store + ".json")


def prefs_get(uid, store):
    try:
        return {"prefs": json.load(open(prefs_path(uid, store), encoding="utf-8")), "found": True}
    except (OSError, ValueError):
        prefs_path(uid, store)   # still validates the name
        return {"prefs": {}, "found": False}


def prefs_put(uid, store, prefs):
    if not isinstance(prefs, dict) or len(json.dumps(prefs)) > 2_000_000:
        raise ValueError("bad prefs")
    p = prefs_path(uid, store)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    json.dump({str(k): (v if v is None else str(v)) for k, v in prefs.items()}, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, p)
    return {"ok": True}


# Cove's own (Jellyfin has none): asked when switching to that person's account on a shared device. 4 to 8 digits,
# stored only as a salted PBKDF2 hash in /data/pins.json, keyed by Jellyfin user id. 5 wrong tries = 1 minute wait.
PINS_F = D("pins.json")
_pin_fails = {}


def _pins():
    try:
        return json.load(open(PINS_F, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _pin_hash(pin, salt):
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 200_000).hex()


def _pin_ok(uid, pin):
    rec = _pins().get(uid)
    return bool(rec) and hmac.compare_digest(_pin_hash(str(pin), rec["salt"]), rec["hash"])


def pin_api(path, body, who):
    pins = _pins()
    if path == "/cove-api/pin/status":   # no sign-in needed: only says whether each account has a PIN
        return {i: i in pins for i in (body.get("ids") or [])[:50] if isinstance(i, str)}
    if path == "/cove-api/pin/check":
        uid = str(body.get("userId") or "")
        n, last = _pin_fails.get(uid, (0, 0))
        if n >= 5 and time.time() - last < 60:
            raise SlowDown(int(60 - (time.time() - last)) + 1)
        if uid not in pins:
            return {"ok": True, "none": True}
        if _pin_ok(uid, body.get("pin") or ""):
            _pin_fails.pop(uid, None)
            return {"ok": True}
        _pin_fails[uid] = (n + 1, time.time())
        raise ValueError("Wrong PIN")
    if not who:
        raise PermissionError("sign in first")
    uid = who[1]
    if path == "/cove-api/pin/set":
        pin = "".join(ch for ch in str(body.get("pin") or "") if ch.isdigit())
        if not 4 <= len(pin) <= 8:
            raise ValueError("Use 4 to 8 digits")
        if uid in pins and not _pin_ok(uid, body.get("current") or ""):
            raise ValueError("Your current PIN isn't right")
        salt = os.urandom(16).hex()
        pins[uid] = {"salt": salt, "hash": _pin_hash(pin, salt), "set": time.strftime("%Y-%m-%d")}
    elif path == "/cove-api/pin/remove":
        if uid in pins and not _pin_ok(uid, body.get("current") or ""):
            raise ValueError("Your current PIN isn't right")
        pins.pop(uid, None)
    elif path == "/cove-api/pin/me":
        return {"has": uid in pins}
    else:
        raise ValueError("unknown")
    tmp = PINS_F + ".tmp"
    json.dump(pins, open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, PINS_F)
    return {"ok": True, "has": uid in pins}


LEVELS = {"kid": 0, "teen": 1, "member": 2, "admin": 3, "owner": 4}


def role_of(me):
    p = person_for(me.get("Name"))
    r = (p or {}).get("role")
    if r in LEVELS:
        return r
    return "admin" if me.get("Policy", {}).get("IsAdministrator") else "member"


def login(req, client_auth):
    who = (req.get("login") or "").strip()
    p = person_for(who)
    name = p["user"] if p else who
    key = name.lower()
    n, last = _fails.get(key, (0, 0))
    if n >= 5 and time.time() - last < 60:
        raise SlowDown(int(60 - (time.time() - last)) + 1)
    body = json.dumps({"Username": name, "Pw": req.get("password") or ""}).encode()
    r = urllib.request.Request(JF + "/Users/AuthenticateByName", data=body, method="POST",
                               headers={"Content-Type": "application/json", "Authorization": client_auth})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            d = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code in (400, 401):
            _fails[key] = (n + 1, time.time())
        raise
    _fails.pop(key, None)
    d["CoveRole"] = (p or {}).get("role") or ("admin" if d.get("User", {}).get("Policy", {}).get("IsAdministrator") else "member")
    d["CoveBooks"] = parts_of(p)["folio"]
    d["CoveParts"] = parts_of(p)
    return d


# "an option to fix and send to you if skip marker detect didnt run good? just for my account"
# /data/marker-overrides.json  {itemId: {name, series, path, segments:[{type,start,end}], at}}  (Cove's player uses these first)
MARKER_FILE = D("marker-overrides.json")
REPORT_FILE = D("marker-reports.jsonl")
MARKER_TYPES = {"Intro", "Recap", "Outro", "Preview", "Commercial"}


def overrides():
    try:
        return json.load(open(MARKER_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_markers(req, auth, uid):
    iid = str(req.get("itemId") or "")
    if not iid.isalnum():
        raise ValueError("bad item")
    segs = []
    for sg in req.get("segments") or []:
        t, a, b = sg.get("type"), float(sg.get("start") or 0), float(sg.get("end") or 0)
        if t in MARKER_TYPES and b > a >= 0:
            segs.append({"type": t, "start": round(a, 1), "end": round(b, 1)})
    item = jf(f"/Items/{iid}", auth, query={"userId": uid, "fields": "Path"})
    if req.get("report"):
        with open(REPORT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"itemId": iid, "name": item.get("Name"), "series": item.get("SeriesName"), "season": item.get("ParentIndexNumber"),
                                "episode": item.get("IndexNumber"), "path": item.get("Path"), "note": (req.get("note") or "")[:2000],
                                "at_seconds": req.get("at"), "markers_now": segs, "detector": req.get("jellyfin") or [],
                                "sent": time.strftime("%Y-%m-%d %H:%M"), "status": "new"}) + chr(10))
        return {"sent": True}
    data = overrides()
    entry = {"name": item.get("Name"), "series": item.get("SeriesName"), "season": item.get("ParentIndexNumber"),
             "episode": item.get("IndexNumber"), "path": item.get("Path"), "segments": segs, "at": time.strftime("%Y-%m-%d %H:%M")}
    if req.get("clear"):
        data.pop(iid, None)
    else:
        data[iid] = entry
    tmp = MARKER_FILE + ".tmp"
    json.dump(data, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, MARKER_FILE)
    if req.get("send"):
        with open(REPORT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({**entry, "itemId": iid, "note": (req.get("note") or "")[:2000], "jellyfin": req.get("jellyfin") or []}) + "\n")
    return {"saved": not req.get("clear"), "sent": bool(req.get("send"))}


# ------------------------------------------------------------------ People page (owner, Nov 18, 2026)
# people.json entries: {"email", "user": Jellyfin name, "role", "emby": Emby account to copy history from, "pending": true until set up}
# Levels -> Jellyfin: owner/admin = Jellyfin admin; member = everything; teen = Allowed tags Kids + Teens; kid = Kids only.
# Nobody gets locked out (LoginAttemptsBeforeLockout -1); cove-api slows guessing instead.
def jf_key_auth():
    return 'MediaBrowser Token="%s"' % _read_key(_svc("video").get("keyFile", "/secrets/jellyfin_api_key.txt"))


def save_people(lst):
    tmp = PEOPLE + ".tmp"
    json.dump(lst, open(tmp, "w", encoding="utf-8"), indent=2)
    os.replace(tmp, PEOPLE)


def jf_users():
    return {u["Name"].lower(): u for u in jf("/Users", jf_key_auth())}


def apply_role(user, role, new=False):
    """The level owns admin, the tag lock and the no-lockout rule. Everything else (library access, playback,
    deletion, remote control...) is set per person on the Users page (Nov 19, 2026) and only defaulted for new people."""
    pol = dict(user["Policy"])
    pol.update({"IsAdministrator": role in ("owner", "admin"), "LoginAttemptsBeforeLockout": -1,
                "AllowedTags": ["Kids", "Teens"] if role == "teen" else ["Kids"] if role == "kid" else [],
                "BlockedTags": [], "MaxParentalRating": None, "BlockUnratedItems": []})
    if new:
        pol.update({"EnableAllFolders": True, "EnableContentDeletion": False, "EnableRemoteControlOfOtherUsers": role in ("owner", "admin")})
    jf(f"/Users/{user['Id']}/Policy", jf_key_auth(), "POST", body=pol)


def people_list():
    users = jf_users()
    out = []
    for p in people():
        u = users.get((p.get("user") or "").lower())
        pol = (u or {}).get("Policy", {})
        out.append({"email": p.get("email"), "name": p.get("user"), "role": p.get("role"), "emby": p.get("emby"),
                    "setUp": bool(u) and not p.get("pending"), "historyCopied": p.get("historyCopied"),
                    "books": has_books(p), "kavita": p.get("kavita"),
                    "allowedTags": pol.get("AllowedTags") or [], "jellyfinAdmin": pol.get("IsAdministrator", False),
                    "userId": (u or {}).get("Id"), "lastActive": (u or {}).get("LastActivityDate"), "disabled": pol.get("IsDisabled", False),
                    "parts": parts_of(p), "partsSet": p.get("parts") or {}})
    return out


def person_by_email(email):
    email = (email or "").strip().lower()
    lst = people()
    for p in lst:
        if (p.get("email") or "").lower() == email:
            return lst, p
    raise ValueError("no such person")


def people_setup(req):
    lst, p = person_by_email(req.get("email"))
    pw = req.get("password") or ""
    if len(pw) < 6:
        raise ValueError("Use at least 6 characters")
    users = jf_users()
    u = users.get(p["user"].lower())
    new = not u
    if not u:
        u = jf("/Users/New", jf_key_auth(), "POST", body={"Name": p["user"], "Password": pw})
    else:
        jf(f"/Users/{u['Id']}/Password", jf_key_auth(), "POST", body={"ResetPassword": True})
        jf(f"/Users/{u['Id']}/Password", jf_key_auth(), "POST", body={"CurrentPw": "", "NewPw": pw})
    u = jf_users()[p["user"].lower()]
    apply_role(u, p.get("role") or "member", new=new)
    if p.get("subs") == "always":
        cfg = dict(u.get("Configuration") or {}, SubtitleMode="Always", SubtitleLanguagePreference="eng")
        jf(f"/Users/{u['Id']}/Configuration", jf_key_auth(), "POST", body=cfg)
    p.pop("pending", None)
    save_people(lst)
    if p.get("emby") and not p.get("historyCopied"):
        auto_history(p["email"])
    if p.get("autoCreate"):
        link_autocreate(p["email"])
    return {"ok": True}


# people linking a thing too so we can link users to their respective servers. or match it. and adding people make it
# available to them and makes a user in that service", "same for emby"). One Cove person = one account in each connected
# service. Stored in the existing fields so nothing else changes: jellyfin = "user", emby = "emby", kavita = "kavita",
# seerr = "seerr" (Seerr user id).
LINK_FIELD = {"jellyfin": "user", "emby": "emby", "kavita": "kavita", "seerr": "seerr"}


def link_services():
    out = ["jellyfin"]
    if EMBY and EMBY_KEY:
        out.append("emby")
    if KAVITA and not part_off("books"):
        out.append("kavita")
    if SEERR and not part_off("requests"):
        out.append("seerr")
    return out


def svc_accounts(svc):
    if svc == "jellyfin":
        return [{"id": u["Id"], "name": u["Name"]} for u in jf("/Users", jf_key_auth())]
    if svc == "emby":
        return [{"id": u["Id"], "name": u["Name"]} for u in emby("/Users")]
    if svc == "kavita":
        return [{"id": u.get("id"), "name": u.get("username"), "email": u.get("email")} for u in kav("/api/Users", kav_admin()) or []]
    if svc == "seerr":
        return [{"id": u["id"], "name": u.get("displayName") or u.get("username") or u.get("jellyfinUsername") or u.get("email") or f"Seerr user {u['id']}",
                 "email": u.get("email"), "jellyfin": u.get("jellyfinUsername")}
                for u in seerr("/user", query={"take": "200"}).get("results", [])]
    return []


def _same(a, b):
    return bool(a) and bool(b) and a.strip().lower() == b.strip().lower()


def people_links():
    svcs = link_services()
    accounts = {}
    for sv in svcs:
        try:
            accounts[sv] = svc_accounts(sv)
        except Exception as e:
            accounts[sv] = []
            print("accounts failed:", sv, type(e).__name__, flush=True)
    lst = people()
    taken = {sv: {str(p.get(LINK_FIELD[sv]) or "").lower() for p in lst if p.get(LINK_FIELD[sv])} for sv in svcs}
    out = []
    for p in lst:
        links, suggest = {}, {}
        for sv in svcs:
            v = p.get(LINK_FIELD[sv])
            acc = next((a for a in accounts[sv] if str(a["id"]) == str(v) or _same(a["name"], str(v or ""))), None) if v else None
            links[sv] = {"name": acc["name"] if acc else v, "id": acc["id"] if acc else None, "missing": bool(v) and not acc} if v else None
            # source then, so no "Match" suggestion for it; linking it stays a manual choice
            if not v and not (sv == "emby" and _svc("video").get("type") == "jellyfin"):
                m = next((a for a in accounts[sv] if str(a["name"] or "").lower() not in taken[sv] and (
                    _same(a["name"], p.get("user")) or _same(a.get("email"), p.get("email")) or _same(a.get("jellyfin"), p.get("user")))), None)
                if m:
                    suggest[sv] = {"name": m["name"], "id": m["id"]}
        out.append({"email": p.get("email"), "name": p.get("user"), "role": p.get("role"), "pending": bool(p.get("pending")),
                    "links": links, "suggest": suggest, "autoCreate": p.get("autoCreate") or []})
    free = {sv: [a["name"] for a in accounts[sv] if str(a["name"] or "").lower() not in taken[sv] and str(a["id"]).lower() not in taken[sv]] for sv in svcs}
    return {"services": svcs, "people": out, "free": free}


def people_link(req):
    lst, p = person_by_email(req.get("email"))
    sv = req.get("service")
    if sv not in link_services():
        raise ValueError("that service isn't connected")
    acct = req.get("account")
    if sv == "jellyfin" and not acct:
        raise ValueError("Every person needs a Jellyfin account")
    if acct:
        acc = next((a for a in svc_accounts(sv) if _same(a["name"], str(acct)) or str(a["id"]) == str(acct)), None)
        if not acc:
            raise ValueError("no such account")
        if any(x is not p and (_same(str(x.get(LINK_FIELD[sv]) or ""), acc["name"]) or str(x.get(LINK_FIELD[sv])) == str(acc["id"])) for x in lst):
            raise ValueError("someone else is already linked to that account")
        if sv == "kavita" and acc["name"] not in kav_keys():
            raise ValueError("Cove doesn't have that Kavita account's key yet; use Create, or add its key")
        p[LINK_FIELD[sv]] = acc["id"] if sv == "seerr" else acc["name"]
    else:
        p.pop(LINK_FIELD[sv], None)     # unlink only: the account and its history stay in that service
    save_people(lst)
    # (never over anything newer); Kavita reading progress and Seerr requests live in the linked account itself.
    if acct and sv == "emby" and jf_users().get((p.get("user") or "").lower()):
        import threading
        def copy():
            try:
                r = people_history({"email": p["email"]})
                print("history copied on link:", p["email"], r, flush=True)
            except Exception as e:
                print("history copy on link failed:", type(e).__name__, e, flush=True)
        threading.Thread(target=copy, daemon=True).start()
        return {"ok": True, "copying": True}
    return {"ok": True}


def _emby_level(uid, role):
    pol = dict(emby(f"/Users/{uid}").get("Policy") or {})
    pol.update({"IsAdministrator": role in ("owner", "admin"), "EnableAllFolders": True,
                "BlockedTags": ["Kids", "Teens"] if role == "teen" else ["Kids"] if role == "kid" else [],
                "IsTagBlockingModeInclusive": role in ("kid", "teen")})   # same allow-list Emby's KIDS account uses
    emby(f"/Users/{uid}/Policy", "POST", body=pol)


def _seerr_level(sid, role):
    u = seerr(f"/user/{sid}")
    perm = u.get("permissions") or 0
    if perm & 2:
        return
    perm = (perm | 32) if role not in ("kid", "teen") else (perm & ~32)   # REQUEST only for members and up
    seerr(f"/user/{sid}/settings/permissions", "POST", {"permissions": perm})


def people_create_account(req, p=None, lst=None):
    if p is None:
        lst, p = person_by_email(req.get("email"))
    sv = req.get("service")
    role = p.get("role") or "member"
    if sv not in link_services():
        raise ValueError("that service isn't connected")
    if p.get(LINK_FIELD[sv]):
        raise ValueError("already linked")
    if sv == "jellyfin":
        raise ValueError("Their Jellyfin account is made when they set their password (Invite)")
    if sv == "emby":
        name = p["user"]
        if any(_same(a["name"], name) for a in svc_accounts("emby")):
            raise ValueError(f"Emby already has a {name}; use Link instead")
        u = emby("/Users/New", "POST", body={"Name": name})
        emby(f"/Users/{u['Id']}/Password", "POST", body={"Id": u["Id"], "CurrentPw": "", "NewPw": _secrets.token_urlsafe(18)})
        _emby_level(u["Id"], role)
        p["emby"] = name
    elif sv == "kavita":
        save_people(lst)
        people_books({"email": p["email"]})          # makes the Kavita account (random password, Cove keeps its key)
        lst, p = person_by_email(p["email"])
    elif sv == "seerr":
        ju = jf_users().get((p.get("user") or "").lower())
        if not ju:
            raise ValueError("Set up their Jellyfin account first")
        made = seerr("/user/import-from-jellyfin", "POST", {"jellyfinUserIds": [ju["Id"]]})
        sid = (made[0] if isinstance(made, list) and made else {}).get("id") or next((a["id"] for a in svc_accounts("seerr") if _same(a.get("jellyfin"), p["user"])), None)
        if not sid:
            raise ValueError("Seerr didn't make the account")
        _seerr_level(sid, role)
        p["seerr"] = sid
    save_people(lst)
    return {"ok": True}


def link_autocreate(email):
    """After someone's Jellyfin account exists (setup or invite), make the other accounts picked when they were added."""
    lst, p = person_by_email(email)
    done = []
    for sv in list(p.get("autoCreate") or []):
        try:
            lst, p = person_by_email(email)
            if not p.get(LINK_FIELD.get(sv, "")):
                people_create_account({"service": sv}, p, lst)
            done.append(sv)
        except Exception as e:
            print("auto-create failed:", sv, type(e).__name__, e, flush=True)
    lst, p = person_by_email(email)
    p["autoCreate"] = [x for x in (p.get("autoCreate") or []) if x not in done]
    if not p["autoCreate"]:
        p.pop("autoCreate")
    save_people(lst)


def people_role(req):
    lst, p = person_by_email(req.get("email"))
    role = req.get("role")
    if role not in LEVELS or role == "owner" or p.get("role") == "owner":
        raise ValueError("can't change that")
    p["role"] = role
    save_people(lst)
    u = jf_users().get(p["user"].lower())
    if u:
        apply_role(u, role)
    try:
        kavita_sync_age(p)
    except Exception as e:
        print("kavita age sync failed:", type(e).__name__, flush=True)
    try:
        if p.get("emby") and EMBY_KEY:
            eu = next((a for a in svc_accounts("emby") if _same(a["name"], p["emby"])), None)
            if eu:
                _emby_level(eu["id"], role)
        if p.get("seerr"):
            _seerr_level(p["seerr"], role)
    except Exception as e:
        print("emby/seerr level sync failed:", type(e).__name__, flush=True)
    return {"ok": True}


def people_add(req):
    email = (req.get("email") or "").strip()
    name = " ".join((req.get("name") or "").split())[:40]
    role = req.get("role") or "member"
    if "@" not in email or not name or role not in LEVELS or role == "owner":
        raise ValueError("needs a name, an email and a level")
    lst = people()
    if any((x.get("email") or "").lower() == email.lower() for x in lst):
        raise ValueError("that email is already here")
    auto = [x for x in (req.get("create") or []) if x in link_services() and x != "jellyfin"]
    lst.append({"email": email, "user": name, "role": role, "emby": req.get("emby") or None, "pending": True,
                **({"autoCreate": auto} if auto else {})})
    save_people(lst)
    return {"ok": True}


def _norm(p):
    p = (p or "").replace("/", "\\").lower()
    mf = (_svc("history").get("mediaFolder") or "").lower().rstrip("\\")
    return mf + "\\" + p[len("\\media\\"):] if mf and p.startswith("\\media\\") else p


def people_history(req):
    """Copy watched + resume spots from the person's Emby account (never overwrites Jellyfin)."""
    lst, p = person_by_email(req.get("email"))
    u = jf_users().get(p["user"].lower())
    if not u or not p.get("emby"):
        raise ValueError("set them up first (and they need an Emby account to copy from)")
    eu = next((x["Id"] for x in emby("/Users") if x["Name"].lower() == p["emby"].lower()), None)
    if not eu:
        raise ValueError("no Emby account named " + p["emby"])
    fields = "Path,ParentIndexNumber,IndexNumber,UserDataPlayCount,UserDataLastPlayedDate"
    played = emby(f"/Users/{eu}/Items", query={"Recursive": "true", "IncludeItemTypes": "Movie,Episode", "IsPlayed": "true", "Fields": fields}).get("Items", [])
    resume = emby(f"/Users/{eu}/Items", query={"Recursive": "true", "IncludeItemTypes": "Movie,Episode", "Filters": "IsResumable", "Fields": fields}).get("Items", [])
    items = jf("/Items", jf_key_auth(), query={"userId": u["Id"], "recursive": "true", "includeItemTypes": "Movie,Episode",
                                                "fields": "Path,ParentIndexNumber,IndexNumber", "enableUserData": "true"}).get("Items", [])
    by_path = {_norm(i.get("Path")): i for i in items if i.get("Path")}
    by_folder = {}
    for i in items:
        if i.get("Path"):
            k = _norm(i["Path"]).rsplit("\\", 1)[0]
            by_folder.setdefault((k, i.get("ParentIndexNumber"), i.get("IndexNumber")) if i["Type"] == "Episode" else k, i)

    def match(e):
        pth = _norm(e.get("Path"))
        if pth in by_path:
            return by_path[pth]
        k = pth.rsplit("\\", 1)[0]
        return by_folder.get((k, e.get("ParentIndexNumber"), e.get("IndexNumber")) if e["Type"] == "Episode" else k)

    done = spots = 0
    for e in played:
        j = match(e)
        if not j or j.get("UserData", {}).get("Played"):
            continue
        ud = e.get("UserData", {})
        body = {"Played": True, "PlayCount": max(1, ud.get("PlayCount") or 1)}
        if ud.get("LastPlayedDate"):
            body["LastPlayedDate"] = ud["LastPlayedDate"]
        jf(f"/UserItems/{j['Id']}/UserData", jf_key_auth(), "POST", query={"userId": u["Id"]}, body=body)
        done += 1
    for e in resume:
        j = match(e)
        if not j or j.get("UserData", {}).get("Played") or j.get("UserData", {}).get("PlaybackPositionTicks"):
            continue
        ud = e.get("UserData", {})
        body = {"PlaybackPositionTicks": ud.get("PlaybackPositionTicks") or 0}
        if ud.get("LastPlayedDate"):
            body["LastPlayedDate"] = ud["LastPlayedDate"]
        jf(f"/UserItems/{j['Id']}/UserData", jf_key_auth(), "POST", query={"userId": u["Id"]}, body=body)
        spots += 1
    if done or spots or not p.get("historyCopied"):   # a re-copy that finds nothing new keeps the first copy's note
        p["historyCopied"] = f"{time.strftime('%Y-%m-%d')}: {done} watched, {spots} resume spots from Emby {p['emby']}"
    save_people(lst)
    return {"watched": done, "spots": spots}


# ------------------------------------------------------------------ invites: they pick their own password
# The owner taps Invite on a waiting person -> a one-time link (#/join/<code>), good for 7 days. Only a hash of the
# code is stored. Opening it shows their name; they choose a password and the account is created with their level.
import secrets as _secrets
INVITE_DAYS = 7


def _h(code):
    return hashlib.sha256(code.encode()).hexdigest()


_setup = {}   # setup id -> {"state": "copying"|"done"|"failed", "watched", "spots", "at"}


def auto_history(email):
    """After someone is set up: copy their Emby history in the background,
    while their screen shows "Setting up Cove" (GET /cove-api/join/status?id=)."""
    import threading
    sid = _secrets.token_urlsafe(12)
    _setup[sid] = {"state": "copying", "at": time.time()}

    def run():
        try:
            r = people_history({"email": email})
            _setup[sid].update(state="done", **r)
            print(f"history copied for {email.split('@')[0]}: {r}", flush=True)
        except Exception as e:
            _setup[sid].update(state="failed")
            print(f"history copy failed: {type(e).__name__}", flush=True)
    threading.Thread(target=run, daemon=True).start()
    for k in [k for k, v in _setup.items() if time.time() - v["at"] > 3600]:
        _setup.pop(k, None)
    return sid


def people_invite(req):
    lst, p = person_by_email(req.get("email"))
    if not p.get("pending"):
        raise ValueError("they're already set up")
    code = _secrets.token_urlsafe(12)
    p["invite"] = {"hash": _h(code), "expires": time.time() + INVITE_DAYS * 86400}
    save_people(lst)
    return {"code": code, "days": INVITE_DAYS}


def _invited(code):
    lst = people()
    for p in lst:
        inv = p.get("invite") or {}
        if inv.get("hash") == _h(code or "") and inv.get("expires", 0) > time.time() and p.get("pending"):
            return lst, p
    raise ValueError("This invite isn't valid anymore. Ask %s for a new one." % owner_name())


def join_info(code):
    _, p = _invited(code)
    return {"name": p["user"], "email": p["email"]}


def join(req):
    lst, p = _invited(req.get("code"))
    pw = req.get("password") or ""
    if len(pw) < 6:
        raise ValueError("Use at least 6 characters")
    users = jf_users()
    u = users.get(p["user"].lower())
    if not u:
        jf("/Users/New", jf_key_auth(), "POST", body={"Name": p["user"], "Password": pw})
    else:
        jf(f"/Users/{u['Id']}/Password", jf_key_auth(), "POST", body={"ResetPassword": True})
        jf(f"/Users/{u['Id']}/Password", jf_key_auth(), "POST", body={"CurrentPw": "", "NewPw": pw})
    apply_role(jf_users()[p["user"].lower()], p.get("role") or "member", new=not u)
    lst, p = _invited(req.get("code"))
    p.pop("pending", None)
    p.pop("invite", None)
    save_people(lst)
    sid = auto_history(p["email"]) if p.get("emby") and not p.get("historyCopied") else None
    if p.get("autoCreate"):
        try:
            link_autocreate(p["email"])
        except Exception as e:
            print("auto-create after join failed:", type(e).__name__, flush=True)
    return {"ok": True, "email": p["email"], "setupId": sid}


# ------------------------------------------------------------------ Books: Cove account -> Kavita session (Nov 18, 2026)
# people.json "kavita": the person's Kavita user name. /data/kavita-keys.json maps Kavita user -> their OPDS auth key
# (copied from a copy of Kavita's DB, never the live file). Kavita's Plugin/authenticate trades the key for a session,
# which the Books tab (Folio at /books/) stores as folio.auth. Same key Folio already keeps after a normal sign-in.
KAVITA = _svc("books").get("url", "")


def books_session(jf_user_name):
    p = next((x for x in people() if (x.get("user") or "").lower() == jf_user_name.lower()), None)
    if not p or not p.get("kavita"):
        raise ValueError("Books aren't set up for your account yet. Ask %s." % owner_name())
    if not parts_of(p)["folio"]:
        raise ValueError("Books are turned off for your account. Ask %s." % owner_name())
    key = kav_keys().get(p["kavita"])
    if not key:
        raise ValueError("Books aren't set up for your account yet. Ask %s." % owner_name())
    req = urllib.request.Request(KAVITA + "/api/Plugin/authenticate?" + urllib.parse.urlencode({"apiKey": key, "pluginName": "Cove"}),
                                 method="POST", data=b"")
    u = json.load(urllib.request.urlopen(req, timeout=20))
    return {"token": u.get("token"), "refreshToken": u.get("refreshToken"), "apiKey": u.get("apiKey") or key,
            "username": u.get("username"), "id": u.get("id"), "roles": u.get("roles") or []}


# Books per person. "Turn On Books" either links an existing Kavita account (its key is in kavita-keys.json) or makes a
# new one: Kavita invite + confirm with a random password nobody sees (they never sign in to Kavita directly; Cove
# trades their key for a session), all three libraries, roles Login/Download/Change Password/Bookmark (never Change
# Restriction), age limit by level: kid = Everyone 10+ (5), teen = Teen (8), others none; unrated hidden for kid/teen.
KEYS = _svc("books").get("keysFile") or D("kavita-keys.json")


def kav(path, token=None, method="GET", body=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(KAVITA + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return raw.decode()


def kav_keys():
    try:
        return json.load(open(KEYS))
    except (OSError, ValueError):
        return {}


def kav_admin():
    key = kav_keys()["admin"]
    return kav("/api/Plugin/authenticate?" + urllib.parse.urlencode({"apiKey": key, "pluginName": "Cove"}), method="POST")["token"]


def kav_age(role):
    return {"ageRating": 5 if role == "kid" else 8 if role == "teen" else -1, "includeUnknowns": role not in ("kid", "teen")}


def has_books(p):
    try:
        return bool(p and p.get("kavita") and kav_keys().get(p["kavita"]))
    except Exception:
        return False


def kavita_unlinked():
    linked = {x.get("kavita") for x in people() if x.get("kavita")}
    return [u for u in kav_keys() if u not in linked and u != "admin"]


def save_keys(k):
    tmp = KEYS + ".tmp"
    json.dump(k, open(tmp, "w"), indent=1)
    os.replace(tmp, KEYS)


def people_books(req):
    lst, p = person_by_email(req.get("email"))
    if req.get("on") is False:
        p.pop("kavita", None)          # their Kavita account and reading progress stay; Books just goes away in Cove
        save_people(lst)
        return {"ok": True}
    link = req.get("link")
    if link:
        if link not in kavita_unlinked():
            raise ValueError("that Kavita account isn't free to link")
        p["kavita"] = link
        save_people(lst)
        return {"ok": True}
    tok = kav_admin()
    uname = _re.sub(r"[^A-Za-z0-9]", "", p["user"]) or "reader"
    taken = {u["username"].lower() for u in kav("/api/Users", tok)}
    base, n = uname, 2
    while uname.lower() in taken:
        uname, n = f"{base}{n}", n + 1
    libs = [l["id"] for l in kav("/api/Library/libraries", tok)]
    inv = kav("/api/Account/invite", tok, "POST", {"email": p["email"], "roles": ["Login", "Download", "Change Password", "Bookmark"],
                                                   "libraries": libs, "ageRestriction": kav_age(p.get("role"))})
    link_url = inv.get("emailLink") if isinstance(inv, dict) else None
    token = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(link_url or "").query)).get("token")
    if not token:
        raise ValueError("Kavita didn't make the invite")
    pw = _secrets.token_urlsafe(18) + "aA1!"
    kav("/api/Account/confirm-email", None, "POST", {"email": p["email"], "username": uname, "password": pw, "token": token})
    me = kav("/api/Account/login", None, "POST", {"username": uname, "password": pw, "apiKey": ""})
    key = me.get("apiKey") or next((k.get("key") for k in me.get("authKeys") or [] if (k.get("name") or "").lower() == "opds"), None)
    if not key:
        raise ValueError("Kavita made the account but gave no key")
    keys = kav_keys()
    keys[uname] = key
    save_keys(keys)
    p["kavita"] = uname
    p["kavitaMade"] = True
    save_people(lst)
    return {"ok": True, "kavita": uname}


def kavita_sync_age(p):
    """After a level change: keep the age limit of a Kavita account Cove made in step with the level."""
    if not p.get("kavita") or not p.get("kavitaMade"):
        return
    tok = kav_admin()
    u = next((x for x in kav("/api/Users", tok) if x["username"] == p["kavita"]), None)
    if u:
        kav("/api/Account/update", tok, "POST", {"userId": u["id"], "username": u["username"], "email": u.get("email"),
                                                "roles": u.get("roles") or ["Login"], "libraries": [l["id"] for l in u.get("libraries") or []],
                                                "ageRestriction": kav_age(p.get("role"))})


# ------------------------------------------------------------------ first-run setup (Cove Server phase 2, Nov 20, 2026,
# setup page needs the one-time setup code printed in the container log (so nobody else on the network can claim the
# server first). Finishing writes cove-config.json, the keys under /data/secrets, people.json with the owner, then
# re-renders the web server's settings and restarts cove-api so the new addresses take effect.
SETUP_CODE_F = D("setup-code.txt")
# what this Cove Server runs on, so the setup page can say where the setup code is (Nov 21, 2026, from the Mac build chat)
import sys as _sys
PLATFORM = "docker" if os.path.exists("/.dockerenv") else {"win32": "windows", "darwin": "mac"}.get(_sys.platform, "linux")
SECRETS = D("secrets")


def setup_done():
    return os.path.exists(PEOPLE)


def setup_code():
    try:
        return open(SETUP_CODE_F).read().strip()
    except OSError:
        import secrets as _s
        code = "-".join("".join(_s.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(4)) for _ in range(2))
        os.makedirs(os.path.dirname(SETUP_CODE_F), exist_ok=True)
        open(SETUP_CODE_F, "w").write(code)
        return code


def _clean_url(u):
    u = (u or "").strip().rstrip("/")
    if u and not u.startswith(("http://", "https://")):
        u = "http://" + u
    return u


def setup_check(req):
    """POST /cove-api/setup/check {code, kind: jellyfin|kavita|seerr, url, user?, password?, key?} -> what Cove found."""
    kind, url = req.get("kind"), _clean_url(req.get("url"))
    if not url:
        raise ValueError("Type the address first")
    try:
        if kind == "jellyfin":
            info = http(url + "/System/Info/Public", timeout=8)
            out = {"ok": True, "name": info.get("ServerName"), "version": info.get("Version")}
            if req.get("user"):
                a = _jf_admin_login(url, req["user"], req.get("password") or "")
                out["user"] = a["User"]["Name"]
            return out
        if kind == "kavita":
            http(url + "/api/health", timeout=8, raw=True)
            out = {"ok": True}
            if req.get("key"):
                u = _kavita_who(url, req["key"])
                out["user"] = u.get("username")
            return out
        if kind == "seerr":
            base = url[:-len("/api/v1")] if url.endswith("/api/v1") else url
            st = http(base + "/api/v1/status", timeout=8)
            out = {"ok": True, "version": st.get("version")}
            if req.get("key"):
                rq = urllib.request.Request(base + "/api/v1/settings/main", headers={"X-Api-Key": req["key"]})
                json.load(urllib.request.urlopen(rq, timeout=8))
                out["keyOk"] = True
            return out
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read(200).decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 403 and ("cloudflare" in (e.headers.get("Server") or "").lower() or "error code" in body):
            raise ValueError("Something in front of it (like Cloudflare) blocked Cove before it reached %s. Use its home address instead, or allow Cove through."
                             % {"jellyfin": "Jellyfin", "kavita": "Kavita", "seerr": "Seerr"}.get(kind, "the server"))
        if e.code in (400, 401, 403):
            raise ValueError({"jellyfin": "Wrong user name or password", "kavita": "That key didn't work",
                              "seerr": "That API key didn't work"}.get(kind, "Not allowed"))
        raise ValueError("It answered, but with an error (%s). Is that the right address?" % e.code)
    except ValueError:
        raise
    except Exception:
        raise ValueError("Can't reach it at that address. From inside Docker, \"localhost\" means Cove itself: "
                         "use the computer's network address (like http://192.168.1.20:8096) or the container's name.")
    raise ValueError("Unknown kind")


def _jf_admin_login(url, user, password):
    hdr = {"Content-Type": "application/json",
           "Authorization": 'MediaBrowser Client="Cove Setup", Device="Cove Server", DeviceId="cove-setup", Version="%s"' % COVE_VERSION}
    rq = urllib.request.Request(url + "/Users/AuthenticateByName", method="POST", headers=hdr,
                                data=json.dumps({"Username": user, "Pw": password}).encode())
    a = json.load(urllib.request.urlopen(rq, timeout=15))
    if not (a.get("User") or {}).get("Policy", {}).get("IsAdministrator"):
        raise ValueError("That Jellyfin account isn't an administrator. Use the one that runs the server.")
    return a


def _kavita_who(url, key):
    rq = urllib.request.Request(url + "/api/Plugin/authenticate?" + urllib.parse.urlencode({"apiKey": key, "pluginName": "Cove"}),
                                method="POST", data=b"")
    u = json.load(urllib.request.urlopen(rq, timeout=15))
    if "Admin" not in (u.get("roles") or []):
        raise ValueError("That key belongs to a Kavita account that isn't an admin. Use the admin's key.")
    return u


def _secret(name, value):
    os.makedirs(SECRETS, exist_ok=True)
    p = os.path.join(SECRETS, name)
    open(p, "w").write(value.strip())
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return p


def setup_finish(req):
    if setup_done():
        raise ValueError("This Cove Server is already set up")
    name = (req.get("name") or "Cove").strip()[:40]
    email = (req.get("email") or "").strip().lower()
    if "@" not in email:
        raise ValueError("Type your email (it's how you'll sign in)")
    jf = req.get("jellyfin") or {}
    jurl = _clean_url(jf.get("url"))
    a = _jf_admin_login(jurl, jf.get("user") or "", jf.get("password") or "")
    tok, owner = a["AccessToken"], a["User"]["Name"]
    auth = 'MediaBrowser Token="%s"' % tok
    # Cove's own Jellyfin key, made with the owner's sign-in (so nobody has to copy one)
    rq = urllib.request.Request(jurl + "/Auth/Keys?" + urllib.parse.urlencode({"App": "Cove Server"}), method="POST",
                                headers={"Authorization": auth}, data=b"")
    urllib.request.urlopen(rq, timeout=15).read()
    keys = json.load(urllib.request.urlopen(urllib.request.Request(jurl + "/Auth/Keys", headers={"Authorization": auth}), timeout=15))
    key = next(k["AccessToken"] for k in reversed(keys.get("Items") or []) if k.get("AppName") == "Cove Server")
    cfg = {"_about": "Cove Server settings, made by the setup page.", "server": dict(CONFIG.get("server") or {})}
    cfg["server"].update({"name": name, "publicUrl": _clean_url(req.get("publicUrl")) or None,
                          "localUrl": _clean_url(req.get("localUrl")) or None, "minAppVersion": "0.1"})
    cfg["video"] = {"type": "jellyfin", "url": jurl, "keyFile": _secret("jellyfin.txt", key)}
    person = {"email": email, "user": owner, "role": "owner"}
    bk = req.get("kavita") or {}
    if _clean_url(bk.get("url")) and bk.get("key"):
        kurl = _clean_url(bk["url"])
        ku = _kavita_who(kurl, bk["key"])
        os.makedirs(DATA, exist_ok=True)
        json.dump({"admin": bk["key"].strip(), ku["username"]: bk["key"].strip()}, open(D("kavita-keys.json"), "w"), indent=1)
        cfg["books"] = {"type": "kavita", "url": kurl, "keysFile": D("kavita-keys.json")}
        person["kavita"] = ku["username"]
    else:
        cfg["books"] = {"type": None, "off": True}
    rq_ = req.get("seerr") or {}
    if _clean_url(rq_.get("url")) and rq_.get("key"):
        surl = _clean_url(rq_["url"])
        surl = surl if surl.endswith("/api/v1") else surl + "/api/v1"
        cfg["requests"] = {"type": "seerr", "url": surl, "keyFile": _secret("seerr.txt", rq_["key"])}
    else:
        cfg["requests"] = {"type": None, "off": True}
    cfg["music"] = {"type": None, "off": True}
    cfg["liveTv"] = True
    pub = cfg["server"]["publicUrl"]
    if pub and pub.startswith("https://"):
        host = urllib.parse.urlparse(pub).hostname
        cfg["passkeys"] = {"rpId": host, "origins": [pub]}
    tmp = CONFIG_F + ".tmp"
    json.dump(cfg, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_F)
    save_people([person])
    try:
        os.remove(SETUP_CODE_F)
    except OSError:
        pass
    # the packaged server re-renders its web server settings and restarts cove-api to load the new settings
    import subprocess, threading
    if not FRONT and os.path.exists("/cove/render_nginx.py"):
        subprocess.run(["python", "/cove/render_nginx.py"], timeout=30)
        subprocess.run(["nginx", "-s", "reload"], timeout=30)
    threading.Timer(1.5, lambda: os._exit(0)).start()
    return {"ok": True, "owner": owner, "email": email}


BACKUPS = os.environ.get("COVE_BACKUPS", "/backups")
BACKUP_LOG = os.environ.get("COVE_BACKUP_LOG", "/backup.log")


# ------------------------------------------------------------------ changing connections after setup (Nov 20, 2026, Cove
# Server phase 2). Owner only. A new address/key is checked before it's saved. Only a Cove Server that serves the app
# in front with fixed addresses, so it only offers the home/outside addresses. Saving restarts cove-api (new settings).
def connection_set(req):
    if not FRONT:
        raise ValueError("This server's addresses are set in its web server settings, not here")
    kind = req.get("kind")
    url = _clean_url(req.get("url"))
    key = (req.get("key") or "").strip()
    if not url:
        raise ValueError("Type the address")
    if kind == "jellyfin":
        k = key or _jf_key()
        try:
            http(url + "/System/Info", headers={"Authorization": 'MediaBrowser Token="%s"' % k}, timeout=8)
        except Exception:
            raise ValueError("Jellyfin didn't answer at that address with Cove's key" + ("" if key else ". Paste a Jellyfin API key too."))
        c = CONFIG.setdefault("video", {})
        c.update({"type": "jellyfin", "url": url})
        if key:
            c["keyFile"] = _secret("jellyfin.txt", key)
    elif kind == "kavita":
        if not key and not kav_keys().get("admin"):
            raise ValueError("Paste the Kavita admin's auth key")
        try:
            ku = _kavita_who(url, key or kav_keys()["admin"])
        except ValueError:
            raise
        except Exception:
            raise ValueError("Kavita didn't answer at that address with that key")
        keys = kav_keys()
        if key:
            keys["admin"] = key
            keys.setdefault(ku["username"], key)
        os.makedirs(DATA, exist_ok=True)
        json.dump(keys, open(KEYS, "w"), indent=1)
        c = CONFIG.setdefault("books", {})
        c.update({"type": "kavita", "url": url, "keysFile": KEYS})
        c.pop("off", None)
    elif kind == "seerr":
        base = url[:-len("/api/v1")] if url.endswith("/api/v1") else url
        k = key or (seerr_key() if (CONFIG.get("requests") or {}).get("url") else "")
        if not k:
            raise ValueError("Paste Seerr's API key")
        try:
            rq = urllib.request.Request(base + "/api/v1/settings/main", headers={"X-Api-Key": k})
            json.load(urllib.request.urlopen(rq, timeout=8))
        except Exception:
            raise ValueError("Seerr didn't answer at that address with that key")
        c = CONFIG.setdefault("requests", {})
        c.update({"type": "seerr", "url": base + "/api/v1"})
        if key:
            c["keyFile"] = _secret("seerr.txt", key)
            c.pop("settingsFile", None)
        c.pop("off", None)
    else:
        raise ValueError("unknown service")
    _save_config()
    import threading
    threading.Timer(1.0, lambda: os._exit(0)).start()      # come back with the new settings
    return {"ok": True, "restarting": True}


def addresses_set(req):
    srv = CONFIG.setdefault("server", {})
    local, public = _clean_url(req.get("localUrl")) or None, _clean_url(req.get("publicUrl")) or None
    if public and not public.startswith("https://"):
        raise ValueError("The outside address has to start with https://")
    srv.update({"localUrl": local, "publicUrl": public})
    if req.get("name"):
        srv["name"] = req["name"].strip()[:40]
    if public:
        host = urllib.parse.urlparse(public).hostname
        CONFIG["passkeys"] = {"rpId": host, "origins": sorted(set((CONFIG.get("passkeys") or {}).get("origins") or []) | {public})}
        passkeys.RP_ID, passkeys.ORIGINS = host, set(CONFIG["passkeys"]["origins"])
    _save_config()
    return {"ok": True, "addresses": {"local": local, "public": public}, "name": srv.get("name")}


def _save_config():
    tmp = CONFIG_F + ".tmp"
    json.dump(CONFIG, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_F)


def backups_status():
    """Server -> Backup page (Nov 20, 2026): each item's latest/previous copy in F:/Backups (mounted read-only) and
    the last nightly run from backup.log."""
    items = []
    if not os.path.isdir(BACKUPS):
        return {"items": [], "last": [], "notSetUp": True}
    for d in sorted(os.listdir(BACKUPS)):
        p = os.path.join(BACKUPS, d)
        if d.startswith("_") or not os.path.isdir(p):
            continue
        files = {}
        for f in os.listdir(p):
            if f.startswith(("latest.", "previous.")) and not f.endswith(".txt"):
                st = os.stat(os.path.join(p, f))
                files[f.split(".")[0]] = {"size": st.st_size, "at": int(st.st_mtime)}
        if files:
            items.append({"name": d, **files})
    last = []
    try:
        lines = open(BACKUP_LOG, encoding="utf-8", errors="replace").read().splitlines()
        end = max((i for i, l in enumerate(lines) if "=== backup done" in l), default=None)   # last full run
        start = max((i for i, l in enumerate(lines[:end] if end is not None else []) if "=== backup start ===" in l), default=None)
        if start is not None:
            last = lines[start:end + 1]
    except OSError:
        pass
    return {"items": items, "lastRun": last}


# ------------------------------------------------------------------ front door (Nov 20, 2026): COVE_FRONT=1 = this program
# also serves the app and passes Jellyfin/Kavita through (front.py), so no nginx is needed (Windows, Mac, Docker image).
FRONT = os.environ.get("COVE_FRONT") == "1"
if FRONT:
    import front as _front
    _here = os.path.dirname(os.path.abspath(__file__))
    FRONT_DOOR = _front.Front(web=os.environ.get("COVE_WEB", os.path.join(_here, "web")),
                              books=os.environ.get("COVE_BOOKS", os.path.join(_here, "books")),
                              setup=os.environ.get("COVE_SETUP", os.path.join(_here, "setup")),
                              config=lambda: CONFIG, setup_done=lambda: setup_done())


class H(BaseHTTPRequestHandler):
    server_version = "cove-api"

    def log_message(self, fmt, *args):  # path only, no query strings or bodies
        print(f"{self.address_string()} {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}", flush=True)

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def admin(self):
        auth = self.headers.get("Authorization", "")
        if "Token=" not in auth:
            return None
        try:
            me = jf("/Users/Me", auth)
            return (auth, me["Id"]) if me.get("Policy", {}).get("IsAdministrator") else None
        except Exception:
            return None

    def user(self):
        auth = self.headers.get("Authorization", "")
        if "Token=" not in auth:
            return None
        try:
            return (auth, jf("/Users/Me", auth)["Id"])
        except Exception:
            return None

    def who_role(self):
        who = self.user()
        if not who:
            return None, None
        try:
            return who, role_of(jf("/Users/Me", who[0]))
        except Exception:
            return None, None

    def seerr_who(self):
        who = self.user()
        if not who:
            return None, None
        try:
            me = jf("/Users/Me", who[0])
        except Exception:
            return None, None
        self.role = role_of(me)
        return who, seerr_user(me.get("Name"))

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")

    def _front(self):
        return FRONT and FRONT_DOOR.handle(self)

    def do_HEAD(self):
        if not self._front():
            self.send(405, {"error": "not allowed"})

    def do_PUT(self):
        if not self._front():
            self.send(405, {"error": "not allowed"})

    def do_DELETE(self):
        if not self._front():
            self.send(405, {"error": "not allowed"})

    def do_OPTIONS(self):
        if not self._front():
            self.send(405, {"error": "not allowed"})

    def do_GET(self):
        if self._front():
            return
        if self.path.startswith("/cove-api/health"):
            return self.send(200, {"ok": True})
        if self.path.startswith("/cove-api/people"):
            try:
                return self.people_api()
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/books/session"):
            who = self.user()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                return self.send(200, books_session(jf("/Users/Me", who[0])["Name"]))
            except ValueError as e:
                return self.send(404, {"error": str(e)})
            except Exception as e:
                return self.send(502, {"error": "Kavita didn't answer (%s)" % type(e).__name__})
        if self.path.startswith("/cove-api/join/status"):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            return self.send(200, _setup.get(q.get("id", ""), {"state": "unknown"}))
        if self.path.startswith("/cove-api/join"):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            try:
                return self.send(200, join_info(q.get("code")))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if self.path.startswith("/cove-api/markers"):
            if not self.user():
                return self.send(403, {"error": "sign in first"})
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            o = overrides().get(q.get("id", ""))
            return self.send(200, {"segments": o["segments"] if o else None})
        if self.path.startswith("/cove-api/admin/host"):
            # Server pages: this server's own details (addresses, router notes, paths, host jobs) from cove-config.json
            if not self.admin():
                return self.send(403, {"error": "admins only"})
            srv = CONFIG.get("server", {})
            return self.send(200, {**(CONFIG.get("host") or {}), "addresses": {"local": srv.get("localUrl"), "public": srv.get("publicUrl")}})
        if self.path.startswith("/cove-api/admin/services"):
            if not self.admin():
                return self.send(403, {"error": "admins only"})
            return self.send(200, services_info())
        if self.path.startswith("/cove-api/admin/tuners"):
            # Server -> Live TV (Nov 20, 2026): what each HDHomeRun tuner is doing right now (the browser can't reach the box)
            if not self.admin():
                return self.send(403, {"error": "admins only"})
            try:
                hosts = jf("/System/Configuration/livetv", key_auth()).get("TunerHosts") or []
                base = next((t.get("Url") for t in hosts if t.get("Type") == "hdhomerun"), None)
                if not base:
                    return self.send(200, {"error": "No HDHomeRun tuner is set up in Jellyfin", "tuners": []})
                st = http(base.rstrip("/") + "/status.json", timeout=5)
                info = http(base.rstrip("/") + "/discover.json", timeout=5)
                keep = ("Resource", "VctNumber", "VctName", "Frequency", "SignalStrengthPercent", "SignalQualityPercent", "SymbolQualityPercent", "TargetIP", "NetworkRate")
                return self.send(200, {"tuners": [{k: t.get(k) for k in keep} for t in st],
                                       "device": {k: info.get(k) for k in ("FriendlyName", "ModelNumber", "FirmwareVersion", "UpgradeAvailable", "TunerCount")}})
            except Exception as e:
                return self.send(200, {"error": str(e), "tuners": []})
        if self.path.startswith("/cove-api/admin/backups"):
            if not self.admin():
                return self.send(403, {"error": "admins only"})
            return self.send(200, backups_status())
        if self.path.startswith("/cove-api/setup/status"):
            return self.send(200, {"done": setup_done(), "version": COVE_VERSION, "platform": PLATFORM})
        if self.path.startswith("/cove-api/server-info"):
            try:
                return self.send(200, server_info())
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/saga/list"):
            who, role = self.who_role()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                return self.send(200, saga_list(who[1], role))
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": f"server said {e.code}"})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/prefs"):
            who = self.user()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
                return self.send(200, prefs_get(who[1], q.get("store", "")))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if self.path.startswith("/cove-api/me"):
            who = self.user()
            if not who:
                return self.send(403, {"error": "sign in first"})
            me = jf("/Users/Me", who[0])
            p = person_for(me.get("Name"))
            return self.send(200, {"name": me.get("Name"), "role": (p or {}).get("role") or ("admin" if me.get("Policy", {}).get("IsAdministrator") else "member"),
                                   "hasEmail": bool((p or {}).get("email")), "books": parts_of(p)["folio"],
                                   "parts": parts_of(p), "owner": owner_name()})
        if self.path.startswith("/cove-api/seerr/") and part_off("requests"):
            return self.send(404, {"error": "Requests aren't set up on this server", "off": True})
        if self.path.startswith("/cove-api/seerr/"):
            who, suid = self.seerr_who()
            if not who:
                return self.send(403, {"error": "sign in first"})
            if LEVELS.get(getattr(self, "role", "member"), 2) < LEVELS["member"]:
                return self.send(403, {"error": "requests are for members and up"})
            try:
                if not parts_of(person_for(jf("/Users/Me", who[0]).get("Name")))["requests"]:
                    return self.send(403, {"error": "Requests are turned off for your account"})
            except Exception:
                pass
            if not suid:
                return self.send(403, {"error": "no Seerr account for this user"})
            u = urllib.parse.urlparse(self.path)
            q = dict(urllib.parse.parse_qsl(u.query))
            try:
                if u.path == "/cove-api/seerr/search":
                    d = seerr("/search", query={"query": q.get("q", ""), "page": "1", "language": "en"})
                    return self.send(200, {"results": [slim(i) for i in d.get("results", []) if i.get("mediaType") in ("movie", "tv")]})
                if u.path == "/cove-api/seerr/requests":
                    if q.get("all") == "1":
                        if LEVELS[self.role] < LEVELS["admin"]:
                            return self.send(403, {"error": "owner or admin only"})
                        return self.send(200, {"requests": seerr_all_requests()})
                    return self.send(200, {"requests": seerr_requests(suid)})
                if u.path == "/cove-api/seerr/autoapprove":
                    if LEVELS[self.role] < LEVELS["admin"]:
                        return self.send(403, {"error": "owner or admin only"})
                    return self.send(200, autoapprove_get())
                if u.path == "/cove-api/seerr/pending":
                    if LEVELS[self.role] < LEVELS["admin"]:
                        return self.send(403, {"error": "owner or admin only"})
                    return self.send(200, {"requests": seerr_pending()})
                if u.path == "/cove-api/seerr/tv":
                    return self.send(200, {"seasons": seerr_tv(q.get("id", 0))})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "Seerr said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        self.send(404, {"error": "not found"})

    def passkey(self):
        u = urllib.parse.urlparse(self.path).path
        if u == "/cove-api/passkey/login/options":
            return self.send(200, passkeys.login_options())
        if u == "/cove-api/passkey/login/verify":
            # the device started a Quick Connect code; once the passkey checks out, approve that code for its owner
            body = self.body()
            uid = passkeys.login_verify(body)
            code = "".join(ch for ch in str(body.get("code") or "") if ch.isdigit())[:10]
            if not code:
                raise ValueError("no sign-in code")
            key = _read_key(_svc("video").get("keyFile", "/secrets/jellyfin_api_key.txt"))
            http(f"{JF}/QuickConnect/Authorize?code={code}&userId={uid}", "POST", b"", {"Authorization": f'MediaBrowser Token="{key}"'})
            return self.send(200, {"ok": True})
        who = self.user()
        if not who:
            return self.send(403, {"error": "sign in first"})
        auth, uid = who
        me = jf("/Users/Me", auth)
        if u == "/cove-api/passkey/register/options":
            return self.send(200, passkeys.register_options(uid, me.get("Name")))
        if u == "/cove-api/passkey/register/verify":
            b = self.body()
            return self.send(200, passkeys.register_verify(uid, me.get("Name"), b, b.get("device") or ""))
        if u == "/cove-api/passkey/list":
            return self.send(200, {"passkeys": passkeys.list_for(uid)})
        if u == "/cove-api/passkey/remove":
            passkeys.remove(uid, self.body().get("id"))
            return self.send(200, {"ok": True})
        return self.send(404, {"error": "not found"})

    def people_api(self):
        who = self.user()
        if not who:
            return self.send(403, {"error": "sign in first"})
        me = jf("/Users/Me", who[0])
        lvl = LEVELS[role_of(me)]
        u = urllib.parse.urlparse(self.path).path
        if u == "/cove-api/people" and self.command == "GET":
            if lvl < LEVELS["admin"]:
                return self.send(403, {"error": "owner or admin only"})
            return self.send(200, {"people": people_list(), "kavitaFree": kavita_unlinked()})
        if u == "/cove-api/people/links" and self.command == "GET":
            if lvl < LEVELS["admin"]:
                return self.send(403, {"error": "owner or admin only"})
            return self.send(200, people_links())
        if u == "/cove-api/people/parts":
            if lvl < LEVELS["admin"]:
                return self.send(403, {"error": "owner or admin only"})
            return self.send(200, people_parts(self.body(), role_of(me)))
        if lvl < LEVELS["owner"]:
            return self.send(403, {"error": "only the owner can change people"})
        body = self.body()
        fn = {"/cove-api/people/invite": people_invite, "/cove-api/people/setup": people_setup, "/cove-api/people/role": people_role,
              "/cove-api/people/add": people_add, "/cove-api/people/books": people_books, "/cove-api/people/history": people_history,
              "/cove-api/people/link": people_link, "/cove-api/people/create-account": people_create_account}.get(u)
        if not fn:
            return self.send(404, {"error": "not found"})
        return self.send(200, fn(body))

    def do_POST(self):
        if self._front():
            return
        if self.path.startswith("/cove-api/join"):
            try:
                return self.send(200, join(self.body()))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/people"):
            try:
                return self.people_api()
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/prefs"):
            who = self.user()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
                return self.send(200, prefs_put(who[1], q.get("store", ""), self.body().get("prefs")))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if self.path.startswith("/cove-api/pin/"):
            try:
                return self.send(200, pin_api(urllib.parse.urlparse(self.path).path, self.body(), self.user()))
            except SlowDown as w:
                return self.send(429, {"error": f"Too many wrong tries. Wait {w.args[0]} seconds and try again."})
            except PermissionError as e:
                return self.send(403, {"error": str(e)})
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/passkey/"):
            try:
                return self.passkey()
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/setup/"):
            if setup_done():
                return self.send(403, {"error": "This Cove Server is already set up"})
            req = self.body()
            if (req.get("code") or "").strip().upper() != setup_code():
                time.sleep(1)
                return self.send(403, {"error": "That setup code isn't right. It's in the Cove Server log."})
            try:
                if self.path.startswith("/cove-api/setup/check"):
                    return self.send(200, setup_check(req))
                if self.path.startswith("/cove-api/setup/finish"):
                    return self.send(200, setup_finish(req))
            except ValueError as e:
                return self.send(400, {"error": str(e.args[0]) if e.args else "Something's off"})
            except urllib.error.HTTPError as e:
                return self.send(400, {"error": "Wrong user name or password" if e.code in (400, 401) else "Server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
            return self.send(404, {"error": "no such step"})
        if self.path.startswith("/cove-api/login"):
            try:
                return self.send(200, login(self.body(), self.headers.get("Authorization", "")))
            except SlowDown as w:
                return self.send(429, {"error": f"Too many wrong tries. Wait {w.args[0]} seconds and try again."})
            except urllib.error.HTTPError as e:
                return self.send(401 if e.code in (400, 401) else 502, {"error": "Wrong email or password" if e.code in (400, 401) else "server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/markers"):
            who = self.admin()
            if not who:
                return self.send(403, {"error": "admins only"})
            try:
                return self.send(200, save_markers(self.body(), *who))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/admin/connection") or self.path.startswith("/cove-api/admin/addresses"):
            who, role = self.who_role()
            if not who or role != "owner":
                return self.send(403, {"error": "only the owner can change this"})
            try:
                fn = connection_set if "/connection" in self.path else addresses_set
                return self.send(200, fn(self.body()))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if self.path.startswith("/cove-api/admin/services"):
            who, role = self.who_role()
            if not who or role != "owner":
                return self.send(403, {"error": "only the owner can change this"})
            try:
                return self.send(200, services_set(self.body()))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
        if self.path.startswith("/cove-api/saga/edit") or self.path.startswith("/cove-api/saga/create"):
            who, role = self.who_role()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                b = self.body()
                if self.path.startswith("/cove-api/saga/create"):
                    return self.send(200, saga_create(b, who[0], who[1], role))
                return self.send(200, saga_edit(b, who[1], role))
            except PermissionError as e:
                return self.send(403, {"error": str(e)})
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": f"server said {e.code}"})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/saga/sync"):
            who = self.user()
            if not who:
                return self.send(403, {"error": "sign in first"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
                sid = req.get("id", "")
                if not sid.isalnum():
                    return self.send(400, {"error": "bad saga id"})
                # a public saga someone else made: repairs are made as its owner (only the owner may change it)
                try:
                    _, m = saga_meta(sid)
                    if m.get("owner") and m["owner"] != who[1]:
                        who = (owner_auth(m["owner"]), m["owner"])
                except Exception:
                    pass
                return self.send(200, {"repaired": saga_sync(sid, *who)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": f"server said {e.code}"})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/seerr/") and part_off("requests"):
            return self.send(404, {"error": "Requests aren't set up on this server", "off": True})
        if self.path.startswith("/cove-api/seerr/autoapprove"):
            who, _ = self.seerr_who()
            if not who or LEVELS.get(getattr(self, "role", "member"), 2) < LEVELS["admin"]:
                return self.send(403, {"error": "owner or admin only"})
            try:
                return self.send(200, autoapprove_set(self.body()))
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "Seerr said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/seerr/decide"):
            who, suid = self.seerr_who()
            if not who or LEVELS.get(getattr(self, "role", "member"), 2) < LEVELS["admin"]:
                return self.send(403, {"error": "owner or admin only"})
            try:
                req = self.body()
                rid = int(req.get("id") or 0)
                seerr(f"/request/{rid}/{'approve' if req.get('approve') else 'decline'}", "POST", body=b"")
                return self.send(200, {"ok": True})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "Seerr said %s" % e.code})
        if self.path.startswith("/cove-api/seerr/request"):
            who, suid = self.seerr_who()
            if not who:
                return self.send(403, {"error": "sign in first"})
            if LEVELS.get(getattr(self, "role", "member"), 2) < LEVELS["member"]:
                return self.send(403, {"error": "requests are for members and up"})
            if not suid:
                return self.send(403, {"error": "no Seerr account for this user"})
            try:
                return self.send(200, seerr_request(suid, self.body(), approve=LEVELS[self.role] >= LEVELS["admin"]))
            except urllib.error.HTTPError as e:
                msg = ""
                try:
                    msg = json.loads(e.read()).get("message", "")
                except Exception:
                    pass
                return self.send(502, {"error": msg or "Seerr said %s" % e.code})
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if self.path.startswith("/cove-api/tags"):
            who = self.admin()
            if not who:
                return self.send(403, {"error": "admins only"})
            try:
                req = self.body()
                ids = [str(x) for x in (req.get("ids") or [])][:500]
                return self.send(200, {"items": set_tags(ids, req.get("add") or [], req.get("remove") or [], *who)})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": "server said %s" % e.code})
            except Exception as e:
                return self.send(500, {"error": type(e).__name__})
        if not self.path.startswith("/cove-api/image"):
            return self.send(404, {"error": "not found"})
        who = self.admin()
        if not who:
            return self.send(403, {"error": "admins only"})
        auth, uid = who
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
            iid, typ = req.get("itemId", ""), req.get("type", "")
            if typ not in TYPES or not iid.isalnum():
                return self.send(400, {"error": "bad item or type"})
            index = int(req.get("index") or 0)
            item = jf(f"/Items/{iid}", auth, query={"userId": uid, "fields": "Path,ProviderIds"})
            eid = find_emby(item)
            if not eid:
                return self.send(200, {"emby": False})
            if req.get("delete"):
                emby(f"/Items/{eid}/Images/{typ}/{index}", "DELETE")
            elif req.get("url"):
                q = {"Type": typ, "ImageUrl": req["url"]}
                if req.get("provider"):
                    q["ProviderName"] = req["provider"]
                emby(f"/Items/{eid}/RemoteImages/Download", "POST", query=q, body=b"")
            elif req.get("data"):
                emby(f"/Items/{eid}/Images/{typ}", "POST", body=req["data"].encode(),
                     headers={"Content-Type": req.get("contentType") or "image/jpeg"})
            else:
                return self.send(400, {"error": "nothing to do"})
            # Jellyfin: drop its own stored copy of this picture (if it made one), then re-read the folder
            for im in jf(f"/Items/{iid}/Images", auth) or []:
                if im.get("ImageType") == typ and (im.get("ImageIndex") or 0) == index and not (im.get("Path") or "").startswith("/media/"):
                    try:
                        jf(f"/Items/{iid}/Images/{typ}" + (f"/{index}" if typ == "Backdrop" else ""), auth, "DELETE")
                    except urllib.error.HTTPError:
                        pass
            time.sleep(1)
            jf(f"/Items/{iid}/Refresh", auth, "POST", query={
                "Recursive": "false", "MetadataRefreshMode": "None", "ImageRefreshMode": "FullRefresh",
                "ReplaceAllImages": "false", "ReplaceAllMetadata": "false"}, body=b"")
            return self.send(200, {"emby": True, "embyId": eid})
        except urllib.error.HTTPError as e:
            return self.send(502, {"error": f"server said {e.code}"})
        except Exception as e:
            return self.send(500, {"error": type(e).__name__})


def main():
    if not setup_done():
        print("\n  Cove Server isn't set up yet. Open it in a browser and use this setup code:  %s\n" % setup_code(), flush=True)
    port = int(os.environ.get("COVE_PORT") or (5050 if FRONT else 8080))
    print("cove-api on :%d%s" % (port, " (serving the app too)" if FRONT else ""), flush=True)
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer((os.environ.get("COVE_HOST", "0.0.0.0"), port), H).serve_forever()


if __name__ == "__main__":
    main()
