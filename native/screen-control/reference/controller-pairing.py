# Independent reference for direct controller pairing v1 (docs/design/mac-to-mac-2026-11-01/DESIGN.md 7.1), written from
# the specification with the Python standard library only: P-256 public keys from fixed scalars (SEC 1), the messages,
# the commitment, T, both codes, the App Attest binding and the bytes each signature covers.
# `python3 -I reference/controller-pairing.py` prints the vectors; `--check <vectors.json>` compares them with the file
# ControllerPairingChecks reads (Tests/ControllerPairingContract/vectors.json) and exits 1 on any difference.
import hashlib, json, sys
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
sha = lambda b: hashlib.sha256(b).digest()
def x963(P): return b'\x04' + P[0].to_bytes(32, 'big') + P[1].to_bytes(32, 'big')
def scalar(name):
    k = int.from_bytes(sha(('agentstoz kat ' + name).encode()), 'big'); assert 0 < k < n; return k
def lp(fields): return b''.join(len(f).to_bytes(4, 'big') + f for f in fields)
L = b'agentstoz.screen-controller-pairing/v1'
def message(tag, fields): return bytes([tag]) + lp(fields)
def code(purpose, T): return '%06d' % (int.from_bytes(sha(L + purpose + T)[:4], 'big') % 1000000)

def vector(case, name_a, model_a, name_b):
    kA, kB = scalar('pairing controller'), scalar('pairing host')
    pkA, pkB = x963(mul(kA, G)), x963(mul(kB, G))
    window = sha(b'agentstoz kat pairing window')[:16]
    nA, nB = sha(b'agentstoz kat pairing controller nonce'), sha(b'agentstoz kat pairing host nonce')
    name_a, model_a, name_b = name_a.encode(), model_a.encode(), name_b.encode()
    commitment = sha(L + b'commit' + window + pkA + pkB + nB)
    T = sha(lp([L, window, pkA, name_a, model_a, pkB, name_b, nA, nB]))
    return {
        'case': case,
        'inputs': {'controllerScalar': 'pairing controller', 'hostScalar': 'pairing host', 'windowID': window.hex(),
                   'controllerName': name_a.decode(), 'controllerModel': model_a.decode(), 'hostName': name_b.decode(),
                   'controllerNonce': nA.hex(), 'hostNonce': nB.hex()},
        'controllerKey': pkA.hex(), 'hostKey': pkB.hex(),
        'serviceName': 'az-mpair-' + window.hex(), 'windowNumber': window.hex()[:4],
        'p1': message(0x21, [b'\x01', pkA, name_a, model_a]).hex(),
        'p2': message(0x22, [window, pkB, name_b, commitment]).hex(),
        'p3': message(0x23, [nA, b'', b'']).hex(),
        'p4': message(0x24, [nB]).hex(),
        'busy': '28',
        'commitment': commitment.hex(),
        'attestationClientDataHash': sha(lp([L, b'attest', window, pkA, name_a, model_a, pkB, commitment, nA])).hex(),
        'transcript': T.hex(),
        'controllerCode': code(b'sas-controller', T),
        'hostCode': code(b'sas-host', T),
        'decisionApproveViewSigned': (L + b' host decision' + T + bytes([1, 1])).hex(),
        'decisionApproveControlSigned': (L + b' host decision' + T + bytes([1, 2])).hex(),
        'decisionRefuseSigned': (L + b' host decision' + T + bytes([2, 0])).hex(),
        'confirmSigned': (L + b' controller confirm' + T).hex(),
        'storedSigned': (L + b' host stored' + T).hex(),
    }

vectors = [vector('ascii', 'Studio', 'Mac14,13', 'Mini'),
           vector('korean names', 'CS의 MacBook Pro', 'Mac15,7', '사무실 iMac')]
if len(sys.argv) == 3 and sys.argv[1] == '--check':
    stored = json.load(open(sys.argv[2], encoding='utf-8'))
    if stored.get('label') != L.decode() or stored.get('vectors') != vectors:
        print('controller pairing vectors differ from the reference'); sys.exit(1)
    print('controller pairing vectors match the reference (%d cases)' % len(vectors))
else:
    print(json.dumps({'label': L.decode(), 'vectors': vectors}, ensure_ascii=False, indent=2))
