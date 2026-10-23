/** Shared agent guidance. It uses existing task context, never a background model call. */
export const MODEL_EFFORT_ADVICE_POLICY = `## Task-aware model and reasoning advice

Unless the connected execution surface's effort mode is off, at the start of substantial planning or work,
give one brief model/effort recommendation
using context already available. For a multi-phase plan, identify the demanding phase and
the condition for lowering effort. Reassess at planning, implementation, verification and
handoff transitions, or when task difficulty materially changes; do not announce an
unchanged recommendation at every transition or on every reply.
- Identify the active agent, model/provider and execution surface where known. Claude,
  Codex, Antigravity (agy) and Hermes do not necessarily expose the same controls; a
  provider's effort labels are not portable to another agent or model. If effort is not
  configurable, say so briefly and recommend a supported alternative only when known.
- Treat model and reasoning effort as separate settings. Use runtime-provided metadata or
  the user's latest explicit statement, and distinguish these sources. If unknown, do not
  guess, claim to have inspected settings, or interrupt routine work just to ask.
- Recommend a higher reasoning level for unresolved concurrency, privilege isolation,
  destructive data migration design, or repeated failures whose cause remains unclear.
  An authentication prompt, missing dependency, network failure, or large token counter
  alone is not a reason to upgrade the model.
- Consider a lower level for routine edits or repetitive work after representative checks
  establish a reliable approach. Do not infer a fixed model ranking from its name, or
  promise cost savings without measured evidence.
- Recommend a specific setting only when the active surface is known to support it.
  Otherwise describe the direction without inventing a model or level. When a change is
  useful, give one short recommendation with its reason, applicable phase, and the condition
  for reassessment. After the initial assessment, staying at the current setting normally
  needs no announcement. Simple questions and trivial edits do not need an effort preamble.
- In an AgentsToZ-registered project, distinguish the execution surface. Workroom and external
  CLI hosts have auto (default), recommend and off. Separate desktop apps (including Codex,
  Claude, Antigravity and Hermes) have recommend (default) and off only. Loading project memory
  or these shared instructions enables contextual recommendations in any app that reads them;
  it never proves access to native settings. Desktop apps never auto-change effort under this policy.
  Use a supplied current host mode when available. A normal local project-memory recall may include
  includeEffortAdvice: true to receive this host's current cliMode/desktopMode alongside memory
  (do not make an extra recall just for advice). Otherwise, at task start and phase transitions,
  read only the relevant small local setting file (maximum 4096 bytes): CLI uses
  workroom-effort-auto.json (v2 mode; legacy v1 auto boolean), desktop uses
  desktop-effort-advice.json (v1 mode: recommend or off). The host app-data directory is
  ~/Library/Application Support/com.portmanager.portmanager on macOS,
  %APPDATA%/com.portmanager.portmanager on Windows, or
  XDG_CONFIG_HOME/com.portmanager.portmanager (default ~/.config/com.portmanager.portmanager) on Linux.
  CLI and desktop choices are independent. Never create or modify these files as part of advice,
  poll them, read other app-data files, or use this device's setting for another execution host.
  When the setting is unavailable, state uncertainty only if relevant; desktop defaults to advice,
  and an unknown execution surface must never be treated as permission for native changes.
  Auto may change CLI effort through a verified current-session control; recommend only advises;
  off suppresses advice (and CLI automatic changes). Reassess using existing context, without another AI call.
  Auto ON is ongoing permission to adjust effort at each new request and task-phase change,
  including after a manual effort choice; no repeated approval is needed. OFF keeps the selected effort.
  Preserve model/provider/account choices and other sessions. Never interrupt a native picker or active input.
  A policy instruction or hook context is not a native effort-setting API. Without a supported
  connected control, report recommendation-only support; never claim a setting was applied.
  Advice alone does not change settings. Keep a fixed effort when the user turns Auto OFF or explicitly requests a fixed level.
  Do not repeat the same recommendation in the same phase
  unless new evidence materially changes it. Continue independent work while waiting.
- Use no extra AI calls, polling loop, transcript copy, or growing advice history. At normal
  session saving, retain only verified, reusable task/check/result lessons in the existing
  project memory. Keep model source and uncertainty explicit; do not attribute success to
  a model without evidence or store current settings as a permanent project preference.
`;
