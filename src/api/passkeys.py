"""Face ID / Touch ID sign-in for Cove (passkeys, WebAuthn), standard library only. Nov 18, 2026.

Registration (signed in): options -> the device makes a passkey -> we keep its PUBLIC key in /data/passkeys.json.
Sign-in: options -> the device signs our challenge with Face ID -> we check the signature with the stored public key ->
cove-api approves a Jellyfin Quick Connect code for that person, and the device finishes signing in with it.
Nothing secret is stored here (public keys only). Supports ES256 (what Apple devices use) and RS256.
"""
import base64
import hashlib
import json
import os
import secrets
import time

STORE = __import__("os").path.join(__import__("os").environ.get("COVE_DATA", "/data"), "passkeys.json")
RP_ID = ""          # set from cove-config.json "passkeys" at start (server.py); empty = Face ID off
ORIGINS = set()
_challenges = {}   # challenge -> (purpose, userId or None, expires)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ------------------------------------------------------------------ tiny CBOR reader (what WebAuthn needs)
def cbor(data, i=0):
    ib = data[i]
    major, info = ib >> 5, ib & 31
    i += 1
    if info < 24:
        val = info
    elif info in (24, 25, 26, 27):
        n = 1 << (info - 24)
        val = int.from_bytes(data[i:i + n], "big")
        i += n
    else:
        raise ValueError("unsupported CBOR")
    if major == 0:
        return val, i
    if major == 1:
        return -1 - val, i
    if major == 2:
        return data[i:i + val], i + val
    if major == 3:
        return data[i:i + val].decode(), i + val
    if major == 4:
        out = []
        for _ in range(val):
            x, i = cbor(data, i)
            out.append(x)
        return out, i
    if major == 5:
        out = {}
        for _ in range(val):
            k, i = cbor(data, i)
            v, i = cbor(data, i)
            out[k] = v
        return out, i
    if major == 7:
        return {20: False, 21: True, 22: None}.get(info), i
    raise ValueError("unsupported CBOR")


# ------------------------------------------------------------------ signature checks (public-key math only)
P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
A = P - 3
G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
     0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    if p == q:
        l = (3 * p[0] * p[0] + A) * pow(2 * p[1], -1, P) % P
    else:
        l = (q[1] - p[1]) * pow(q[0] - p[0], -1, P) % P
    x = (l * l - p[0] - q[0]) % P
    return x, (l * (p[0] - x) - p[1]) % P


def _mul(k, p):
    r = None
    while k:
        if k & 1:
            r = _add(r, p)
        p = _add(p, p)
        k >>= 1
    return r


def _der_sig(sig):
    # ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }
    assert sig[0] == 0x30
    i = 2
    assert sig[i] == 0x02
    lr = sig[i + 1]
    r = int.from_bytes(sig[i + 2:i + 2 + lr], "big")
    i += 2 + lr
    assert sig[i] == 0x02
    ls = sig[i + 1]
    s = int.from_bytes(sig[i + 2:i + 2 + ls], "big")
    return r, s


def verify(cose, msg, sig):
    kty, alg = cose.get(1), cose.get(3)
    if kty == 2 and alg == -7:              # EC2 P-256, ES256
        qx, qy = int.from_bytes(cose[-2], "big"), int.from_bytes(cose[-3], "big")
        r, s = _der_sig(sig)
        if not (1 <= r < N and 1 <= s < N):
            return False
        e = int.from_bytes(hashlib.sha256(msg).digest(), "big")
        w = pow(s, -1, N)
        pt = _add(_mul(e * w % N, G), _mul(r * w % N, (qx, qy)))
        return pt is not None and pt[0] % N == r
    if kty == 3 and alg == -257:            # RSA, RS256 (PKCS#1 v1.5)
        n, e = int.from_bytes(cose[-1], "big"), int.from_bytes(cose[-2], "big")
        k = (n.bit_length() + 7) // 8
        em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
        digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(msg).digest()
        return em == b"\x00\x01" + b"\xff" * (k - len(digest_info) - 3) + b"\x00" + digest_info
    return False


# ------------------------------------------------------------------ storage
def load():
    try:
        return json.load(open(STORE, encoding="utf-8"))
    except Exception:
        return []


def save(creds):
    tmp = STORE + ".tmp"
    json.dump(creds, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, STORE)


def _challenge(purpose, uid=None):
    now = time.time()
    for k in [k for k, v in _challenges.items() if v[2] < now]:
        _challenges.pop(k, None)
    c = b64u(secrets.token_bytes(32))
    _challenges[c] = (purpose, uid, now + 300)
    return c


def _check_client(client_json_b64, kind, purpose):
    cd = json.loads(unb64u(client_json_b64))
    if cd.get("type") != kind:
        raise ValueError("wrong type")
    if cd.get("origin") not in ORIGINS:
        raise ValueError("wrong site")
    ch = _challenges.pop(cd.get("challenge", ""), None)
    if not ch or ch[0] != purpose or ch[2] < time.time():
        raise ValueError("challenge expired, try again")
    return ch, unb64u(client_json_b64)


# ------------------------------------------------------------------ registration
def register_options(uid, name):
    return {"challenge": _challenge("reg", uid), "rp": {"id": RP_ID, "name": "Cove"},
            "user": {"id": b64u(bytes.fromhex(uid)), "name": name, "displayName": name},
            "pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
            "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
            "attestation": "none", "timeout": 120000,
            "excludeCredentials": [{"type": "public-key", "id": c["id"]} for c in load() if c["user"] == uid]}


def register_verify(uid, name, body, device):
    ch, _ = _check_client(body["clientDataJSON"], "webauthn.create", "reg")
    if ch[1] != uid:
        raise ValueError("signed-in user changed")
    att, _ = cbor(unb64u(body["attestationObject"]))
    ad = att["authData"]
    if ad[:32] != hashlib.sha256(RP_ID.encode()).digest():
        raise ValueError("wrong site")
    flags = ad[32]
    if not (flags & 0x01 and flags & 0x04 and flags & 0x40):
        raise ValueError("Face ID wasn't used")
    cred_len = int.from_bytes(ad[53:55], "big")
    cred_id = ad[55:55 + cred_len]
    cose, _ = cbor(ad, 55 + cred_len)
    creds = [c for c in load() if c["id"] != b64u(cred_id)]
    creds.append({"id": b64u(cred_id), "user": uid, "name": name, "device": device[:60],
                  "cose": {str(k): (b64u(v) if isinstance(v, bytes) else v) for k, v in cose.items()},
                  "count": int.from_bytes(ad[33:37], "big"), "added": time.strftime("%Y-%m-%d %H:%M")})
    save(creds)
    return {"ok": True}


# ------------------------------------------------------------------ sign-in
def login_options():
    return {"challenge": _challenge("login"), "rpId": RP_ID, "userVerification": "required", "timeout": 120000, "allowCredentials": []}


def login_verify(body):
    """Returns the Jellyfin user id whose passkey signed the challenge."""
    _, client_raw = _check_client(body["clientDataJSON"], "webauthn.get", "login")
    creds = load()
    c = next((x for x in creds if x["id"] == body.get("id")), None)
    if not c:
        raise ValueError("this passkey isn't set up in Cove")
    ad = unb64u(body["authenticatorData"])
    if ad[:32] != hashlib.sha256(RP_ID.encode()).digest():
        raise ValueError("wrong site")
    if not (ad[32] & 0x01 and ad[32] & 0x04):
        raise ValueError("Face ID wasn't used")
    cose = {int(k): (unb64u(v) if isinstance(v, str) else v) for k, v in c["cose"].items()}
    if not verify(cose, ad + hashlib.sha256(client_raw).digest(), unb64u(body["signature"])):
        raise ValueError("signature didn't check out")
    count = int.from_bytes(ad[33:37], "big")
    if count and c.get("count") and count <= c["count"]:
        raise ValueError("this passkey looks copied")
    c["count"], c["used"] = count, time.strftime("%Y-%m-%d %H:%M")
    save(creds)
    return c["user"]


def list_for(uid):
    return [{"id": c["id"], "device": c.get("device"), "added": c.get("added"), "used": c.get("used")} for c in load() if c["user"] == uid]


def remove(uid, cid):
    save([c for c in load() if not (c["user"] == uid and c["id"] == cid)])
