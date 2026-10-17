import type {VoiceProjectChoice} from './voiceSessionProtocol';

/** Only a complete selected # token grants its project as context to the voice host. */
export function voiceMentionReferences(text: string, selected: readonly VoiceProjectChoice[]): string[] {
  return selected.filter(project => {
    const token = `#${project.label}`;
    let at = text.indexOf(token);
    while (at !== -1) {
      const next = text.slice(at + token.length).match(/^./u)?.[0] ?? '';
      // A letter, digit or connector means the person edited the token into a
      // different name. Slash also belongs to device-qualified # mentions.
      if (!next || !/[\p{L}\p{N}\p{M}_/-]/u.test(next)) return true;
      at = text.indexOf(token, at + token.length);
    }
    return false;
  }).map(project => project.id);
}
