# AgentsToZ computer use

`ComputerUseEngine` is shared by the independent signed **AgentsToZ Control.app** and the lab worker. Production callers use the existing Main → private sidecar channel → signed XPC → Control grant path. They cannot start a lab worker or approve themselves.

The engine observes one exact process/window and retains the original Accessibility objects for a single `press`, `set-value` or `click` attempt. Ordinary text fields and text areas are supported. Secure fields are excluded before reading their labels or values. A stale object, changed value, disabled/read-only field, changed window, active human or missing permission refuses input. Unknown delivery is never replayed.

When the person also turned on screen images for that grant in Control (off by default; a request cannot turn it on) and macOS Screen Recording is allowed for Control (Control checks it but never requests it), `capture` returns an ephemeral JPEG of the one bound window, at most 1280 px on the longest side and 240,000 bytes, never persisted. `click` takes a window-relative point from that capture and sends AXPress to the exact observed button at that point (or the nearest observed button ancestor of a passive label/image/group hit); it never synthesizes a mouse event. A miss, an unobserved element or a moved/resized window is refused before anything is sent. The hit object and every observed parent/child link are revalidated before dispatch; fields and unknown canvas roles are never climbed to another control. Modal/dialog windows and attached sheets block observations, captures and writes; unreadable modal metadata fails closed. This is an AX metadata guard, not proof that every custom app can identify its sensitive UI.

## Checks

```sh
swift test --package-path native/computer-use --disable-automatic-resolution --filter ExactAXTreeTests
bun scripts/check-computer-use-control.ts
```

The deterministic engine suite also runs in the normal `native-workflow-foundations` project check on macOS. It creates no windows, prompts, grants or installed state.

For a real Mac engine check, using already available Accessibility permission:

```sh
swift run --package-path native/computer-use --disable-automatic-resolution agentstoz-computer-use-native-lab
```

This executable creates its own temporary ad-hoc test app, two same-title windows, ordinary/secure fields and a button. It accepts no external target. It checks Unicode input, button activation, independent application readback, secure-field omission, preservation of the other window and preservation of human focus/pointer. It then terminates only its child and removes only its temporary directory. Without Accessibility permission it returns `blocked` without prompting. An engine pass reports `productionGrantTested:false`: it does not establish signed XPC, TCC attribution to Control, Touch ID approval or production installation.

## Release boundary

Build the signed Control app with `scripts/build-computer-use-control-app.ts` and its dedicated Developer ID profile. A signed helper alone is insufficient: the installed Main must satisfy the reciprocal Developer ID requirement, and Control needs its own background registration, Accessibility permission and human approval. See [CONTRACT.md](CONTRACT.md).

Hermes/Orca team adapters, whole-desktop screenshots, synthesized mouse or keyboard input, clicks on canvas pixels or other unobserved points, and app launching are not implemented by this engine. The bounded `capture`/`click` above covers one approved window only. The binding/approval work a team-app target would still need is tracked in [TEAM-APP-CONTROL.md](../../docs/design/computer-use-2026-10-26/TEAM-APP-CONTROL.md). An AX engine pass must not be reported as success controlling those applications.
