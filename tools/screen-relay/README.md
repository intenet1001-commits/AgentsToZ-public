# AgentsToZ screen relay (v1)

An **untrusted byte mover** for the native screen-control protocol. Nearby Apple peer-to-peer Wi‑Fi
stays the default route; this relay exists so the same protocol also works over LTE.

It pairs one host (the Mac helper) with one controller (iPhone/iPad) in a room and copies opaque
binary frames between them — exactly, in order, under hard budgets.

> **Not deployed.** No deployment is authorized yet. Everything below describes how it *would* run.

Contract: `/tmp/agentstoz-screen-relay-contract-20261026.md`

---

## What it cannot do

This is the important part. The relay is assumed hostile by the rest of the system:

- **It cannot decrypt registration or screen/input contents.** QR-v2 registration frames use the independent QR secret, fresh per-connection salts and direction-bound AES-GCM. Authenticated screen/input records use the native session keys. Public screen-handshake keys, pseudonymous device IDs, frame lengths and timing remain observable. Session keys
  never reach this process — only the Mac helper and the paired device hold them.
- **It holds no native authentication authority whatsoever.** Joining a room is *transport
  admission only*. Every decision that actually grants screen viewing or input lives end to end,
  outside this server: the SIGMA key exchange, per-connection Face ID on the device, App Attest at
  registration, and the Mac's own Touch ID approval. A relay that admits anyone it likes — or that
  is fully compromised — still cannot make the Mac stream to them, inject a single input event, or
  register a device. The room capability authorizes *being connected*, never *being trusted*.
- **It cannot resume a session.** Losing one peer closes the other. An established native session is
  never silently replayed or reattached.
- **It can deny service.** That is the whole of its power.

The `{"type":"authenticated"}` frame is a **resource-budget signal, not an authorization.** It only
raises the size cap after the native key confirmation; neither native endpoint trusts it.

### The routing capability is deliberately held here

The room's capability is private routing metadata, and this server keeps it in memory to match a
host with a controller. **That is the original threat model, not a gap:** an attacker who reads this
process's memory gains transport admission and nothing else — no key, no session, no input path,
no registration. The capability is never put in a URL, a log line or an error body. It is not
wrapped in a server-held secret (an HMAC, say), because that would give the relay a secret of its
own and weaken exactly the property that makes it safe to distrust.

---

## Running it

```sh
# loopback, port 8787
bun tools/screen-relay/src/main.ts

# another port
RELAY_PORT=8080 bun tools/screen-relay/src/main.ts
```

Only `/screen-relay` upgrades. Every other path is 404, a query string is 400 (the room capability
must never travel in a URL), and a plain GET on the right path is 426.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Bind address. A wildcard (`0.0.0.0`, `::`) is **refused** — see TLS below. |
| `RELAY_PORT` | `8787` | `0` asks the OS for an ephemeral port. |
| `RELAY_CHALLENGE_TTL_MS` | `5000` | Time to join after the challenge. |
| `RELAY_MAX_ROOMS` | `256` | Live rooms (per room+purpose). |
| `RELAY_MAX_SOCKETS` | `512` | Live sockets server-wide. |
| `RELAY_MAX_SOCKETS_PER_IP` | `8` | Simultaneous sockets per IP. |
| `RELAY_MAX_ADMISSIONS_PER_IP` | `30` | Joins per IP per minute. |
| `RELAY_IDLE_WAITING_MS` | `120000` | How long a side may wait unpaired. |
| `RELAY_ACTIVE_LIFETIME_MS` | `3600000` | Absolute session lifetime. |

---

## TLS: terminate it in a reverse proxy

**This server speaks plain WebSocket and binds loopback. It does not terminate TLS, and nothing in
it weakens, skips or works around certificate verification.**

Production clients connect with `wss://` and **normal certificate validation**. Saved product
settings never accept `ws://`; a `ws://127.0.0.1` URL is only for the local deterministic fixtures in
`tests/`.

Put a properly certificated reverse proxy in front and keep this process on loopback:

```nginx
# nginx — the proxy owns the certificate; the relay never sees it
location /screen-relay {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;

    # Frames can reach 8 MiB + 25 after the host's budget signal.
    client_max_body_size 16m;
    proxy_read_timeout 3600s;   # at least RELAY_ACTIVE_LIFETIME_MS
    proxy_send_timeout 3600s;
}
```

Caddy equivalent:

```caddy
relay.example.com {
    # Caddy obtains and validates a real certificate; do not disable that.
    reverse_proxy /screen-relay 127.0.0.1:8787
}
```

Two consequences worth stating plainly:

1. **Per-IP budgets see the proxy's address unless the proxy forwards the client's.** This server
   currently keys rate limits on the socket's peer address (`requestIP`). Behind a proxy that is the
   proxy. Either run the proxy so it preserves the client address at the transport layer, or treat
   the per-IP budgets as per-proxy and rely on the room/socket ceilings. Trusting
   `X-Forwarded-For` blindly would let any client forge its own bucket, so this server does **not**
   read it — see "Known limits" below.
2. **Do not expose this port directly.** A wildcard bind is refused for exactly that reason.

---

## Wire protocol (v1)

Not to be confused with the encrypted screen protocol it carries.

1. **Challenge.** On upgrade the server sends `{"type":"challenge","nonce":"<32 bytes base64url>"}`.
   One-use, per socket, 5 seconds to join.
2. **Room.** `<64 lowercase hex Mac SHA-256(x963 P-256 public key)>.<43-char base64url capability>`.
   The capability is private QR/Keychain routing metadata — never a URL query, never a log field.
3. **Host join.**
   ```json
   {"type":"join","version":1,"role":"host","purpose":"screen",
    "room":"…","publicKey":"<65B x963 base64>","signature":"<64B raw P-256 base64>"}
   ```
   The host signs `UTF8("agentstoz.screen-relay/v1 host\n" + purpose + "\n" + room + "\n" + nonce)`
   — CryptoKit ECDSA/SHA-256, verified here with WebCrypto. `SHA256(publicKey)` must equal the room
   prefix, so **a controller who scanned the room cannot squat as host**, and the fresh nonce stops
   replay.
4. **Controller join.** `{"type":"join","version":1,"role":"controller","purpose":"…","room":"…"}`.
   The capability is required but confers no screen or input authority.
5. **Pairing.** One host and one controller per room+purpose. A host may wait; a controller with no
   live host gets `offline` **without creating the room** (so it cannot consume a future host); a
   second controller while busy gets `busy` and the active session is left alone. Each side then
   receives `{"type":"paired","peerId":"<16 bytes base64url>"}`. **No binary before `paired`.**
6. **Frames.** Each binary WebSocket message is one native protocol frame, no TCP length header.
   Exact bytes and order are preserved in both directions.
7. **Sizes.** 16 KiB until the host sends `{"type":"authenticated"}` on a *screen* room; after that
   8 MiB + 25 (the existing GCM record limit: 8 MiB payload + 9 header + 16 tag). Registration is
   always 16 KiB.
8. **Errors.** `{"type":"error","code":"malformed"|"unauthorized"|"offline"|"busy"|"limited"|"expired"}`,
   then close. All other text after pairing is refused. There is no command, channel or injection
   endpoint.

### Logging

Counts only. **No authentication body, session, token, frame, key or room capability is ever
logged.** `roomLabel()` exists so a diagnostic can name a room by a fingerprint prefix without its
capability.

---

## Tests

Real Bun WebSocket clients against a relay on `127.0.0.1` with an OS-assigned ephemeral port.
Nothing mocks the transport — the point is that the bytes genuinely cross a socket.

```sh
cd tools/screen-relay
bun test ./tests/relay.test.ts
```

50 tests, 347 assertions, covering:

| Area | What is proved |
|---|---|
| Challenge | per-socket one-use nonce; expiry; a join replayed onto another socket is `unauthorized`; a signature for another purpose fails; a controller cannot squat as host |
| Duplicate host join flood | 24 copies of one valid join cost **exactly one** signature verification; duplicates are refused; an invalid-join flood verifies at most once; many sockets stay bounded by the per-IP budget; closing or expiring mid-verification attaches nothing and leaks no room |
| Strict schema | non-JSON, wrong type/version/role/purpose, malformed room, array body, **extra field**, overlong text, binary before pairing |
| Pairing | `offline` without a live host and no room created; distinct peer ids; no binary before `paired`; second host/controller gets `busy` without disturbing the session; screen and registration are separate rooms; idle-wait expiry |
| Bytes | byte-for-byte and in-order both directions; a 120-frame interleaved run stays ordered; the relay injects and echoes nothing |
| Sizes | 16 KiB boundary exactly; larger passes only after `authenticated`; registration stays 16 KiB; oversize refused |
| Pressure | per-peer and global pending budgets close **both** peers; no partial or truncated frame is ever delivered |
| Rate/counts | per-IP admissions; a malformed flood does not spend the budget; socket and room ceilings; absolute lifetime |
| Cleanup | peer loss closes the other side and frees the room; an ended session is not resumable; a waiting host leaves no room; repeated cycles leak no rooms, sockets or pending bytes |

### A note on the fixture

Host admission is asynchronous (WebCrypto verification), and a waiting host gets no acknowledgement
— only `paired`. A controller that joins before verification finishes is therefore told `offline`,
which is the **contract's correct answer**, not a defect. The fixture waits for the room to exist
before connecting the controller; a real controller should retry on `offline`.

### One challenge, one verification

`RelayCore` enters a `verifying` phase **synchronously**, before the first `await` of host
admission. Without it the socket would still read `challenged` when the next copy of a join
arrived, and every copy would start another P‑256 verification against the same nonce — CPU
amplification from one unauthenticated socket. `stats().hostVerifications` exists so the tests can
assert that bound directly. A verification that resolves after its socket was closed, refused or
expired finds a different phase and decides nothing.

## Typecheck

`tsconfig.json` in this directory covers `src/` and `tests/` only. It is deliberately scoped here
so the repository's root `tsconfig.json` and `package.json` stay untouched. Run it with the
repository's own TypeScript CLI:

```sh
cd tools/screen-relay
node ../../node_modules/typescript/lib/tsc.js -p tsconfig.json \
  --typeRoots ../../node_modules/@types
```

Clean under TypeScript 5.9.3 with `strict` and Bun types.

---

## Known limits

- **Per-IP budgets behind a proxy count the proxy as one IP.** This is the intended conservative
  posture for initial deployment: `X-Forwarded-For` is **not** trusted, because a client could
  forge its own bucket and escape the budget entirely. The consequence is that per-IP admission and
  socket limits apply to the proxy as a whole, so the room, socket and lifetime ceilings are what
  bound a busy deployment. Revisit only with a transport-level mechanism that preserves the client
  address without trusting a client-settable header.
- **Back-pressure accounting** uses Bun's `getBufferedAmount()` plus the `drain` callback. It is
  a close approximation of bytes in flight, not an exact kernel-level figure.
- **No TLS, no deployment, no public bind.** By design, and none of it is configured here.
- The nearby peer-to-peer route (Bonjour service types, `includePeerToPeer = true`) and all native
  transport, app UI, invitation QR and persistence are **owned by Codex**, not by this directory.

## Files

| File | Role |
|---|---|
| `src/protocol.ts` | Wire schema, strict parsing/encoding, signature message construction |
| `src/limits.ts` | Every bound, all configurable; fixed-window per-key counter |
| `src/hostChallenge.ts` | SHA-256 fingerprint check + WebCrypto P-256 verification; pair keys |
| `src/server.ts` | `RelayCore` state machine and the `Bun.serve` wiring |
| `src/main.ts` | CLI entry: env parsing, wildcard-bind refusal, signal handling |
| `tests/fixture.ts` | Ephemeral-port relay, recording clients, P-256 Mac identity helpers |
| `tests/relay.test.ts` | The 50 real-socket tests above |
| `tsconfig.json` | Typecheck scope for this directory only |
