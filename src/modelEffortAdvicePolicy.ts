/** Shared agent guidance. It uses existing task context, never a background model call. */
export const MODEL_EFFORT_ADVICE_POLICY = `## Task-aware model and reasoning advice

At the start of substantial planning or work, give one brief model/effort recommendation
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
- Advice does not change settings. Never switch automatically, and honor the user's choice
  to keep the current setting. Do not repeat the same recommendation in the same phase
  unless new evidence materially changes it. Continue independent work while waiting.
- Use no extra AI calls, polling loop, transcript copy, or growing advice history. At normal
  session saving, retain only verified, reusable task/check/result lessons in the existing
  project memory. Keep model source and uncertainty explicit; do not attribute success to
  a model without evidence or store current settings as a permanent project preference.
`;
