import {type AiTerminalAgent} from './aiTerminalProtocol';

/**
 * How each CLI takes an initial prompt while STAYING interactive in the workroom PTY.
 *
 * These are not interchangeable. Measured against the installed CLIs:
 *   codex  : `codex [OPTIONS] [PROMPT]`      positional
 *   claude : `claude [options] [prompt]`     positional
 *   hermes : `hermes chat -q PROMPT`         `--` is rejected: "'--' is not a `hermes` command"
 *   agy    : `agy -i PROMPT`                 `--prompt-interactive`; plain `--print` would
 *                                            answer once and exit instead of continuing.
 *
 * Passing the positional form to hermes/agy is why prompt-carrying launches used to be
 * refused for them: the process would have died on startup instead of opening a session.
 */
export function aiTerminalPromptArgs(agent: AiTerminalAgent, prompt: string): string[] {
  switch (agent) {
    case 'hermes':
      // `chat` is the interactive entry point; -q seeds the first turn on a real TTY.
      return ['chat', '-q', prompt];
    case 'agy':
      return ['-i', prompt];
    case 'codex':
    case 'claude':
      // `--` keeps a prompt that begins with `-` from being read as a flag.
      return ['--', prompt];
  }
}

/** Every workroom agent can now carry an initial prompt. */
export function aiTerminalSupportsPrompt(agent: AiTerminalAgent): boolean {
  return agent === 'codex' || agent === 'claude' || agent === 'hermes' || agent === 'agy';
}
