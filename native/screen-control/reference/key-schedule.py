# Independent reference for the screen-control key schedule: P-256 ECDH, H(T) and HKDF-SHA256, written from the
# specifications (SEC 1, RFC 5869) with the Python standard library only. `python3 -I reference/key-schedule.py`
# prints the values testKeyScheduleMatchesTheIndependentReference (version 1) and
# testVersionTwoKeyScheduleMatchesTheReference (version 2, negotiated in the nonces) pin.
import hashlib, hmac
p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
a = -3
G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
     0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)
def add(P, Q):
    if P is None: return Q
    if Q is None: return P
    if P[0] == Q[0] and (P[1] + Q[1]) % p == 0: return None
    if P == Q: l = (3 * P[0] * P[0] + a) * pow(2 * P[1], -1, p) % p
    else: l = (Q[1] - P[1]) * pow(Q[0] - P[0], -1, p) % p
    x = (l * l - P[0] - Q[0]) % p
    return (x, (l * (P[0] - x) - P[1]) % p)
def mul(k, P):
    R = None
    while k:
        if k & 1: R = add(R, P)
        P = add(P, P); k >>= 1
    return R
def x963(P): return b'\x04' + P[0].to_bytes(32, 'big') + P[1].to_bytes(32, 'big')
def scalar(name):
    d = hashlib.sha256(('agentstoz kat ' + name).encode()).digest()
    k = int.from_bytes(d, 'big'); assert 0 < k < n; return k
def lp(fields): return b''.join(len(f).to_bytes(4, 'big') + f for f in fields)
def hkdf(salt, ikm, info):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b'\x01', hashlib.sha256).digest()
sha = lambda b: hashlib.sha256(b).digest()
macId, devId, devEph, macEph = (mul(scalar(x), G) for x in ['mac identity', 'device identity', 'device ephemeral', 'mac ephemeral'])
shared = mul(scalar('device ephemeral'), macEph)[0].to_bytes(32, 'big')
assert shared == mul(scalar('mac ephemeral'), devEph)[0].to_bytes(32, 'big')
# Version 2 is negotiated inside the nonces: each ends with the marker and a big-endian version (Handshake.swift
# VersionStamp), and the version both ends settled on is the one in T and in every label.
stamp = lambda nonce, version: nonce[:22] + b'AZScreen' + version.to_bytes(2, 'big')
for version, Np, Nm in [(1, b'\x11' * 32, b'\x22' * 32), (2, stamp(b'\x11' * 32, 2), stamp(b'\x22' * 32, 2))]:
    T = lp([b'agentstoz.screen-control', version.to_bytes(2, 'big'), sha(x963(macId)), sha(x963(devId)), Np, x963(devEph), Nm, x963(macEph)])
    H = sha(T)
    base = 'agentstoz.screen-control/v%d' % version
    print('version', version)
    print('transcriptHash', H.hex())
    for label in ['mac->device', 'device->mac', 'confirm mac', 'confirm device']:
        print(label, hkdf(H, shared, (base + ' ' + label).encode()).hex())
