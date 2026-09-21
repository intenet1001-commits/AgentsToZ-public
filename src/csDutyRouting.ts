/** Explicit text commands only. Never infer a project from the question's subject. */
export const normalizeDutyAlias = (value: string) => value.normalize('NFC').trim().replace(/^#/, '').toLowerCase();
export const validDutyAlias = (value: string) => /^[a-z0-9가-힣][a-z0-9가-힣-]{0,29}$/.test(value);
export const suggestDutyAlias = (name: string) => normalizeDutyAlias(name).replace(/[^a-z0-9가-힣-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
export type DutyInvocation = { alias: string | null; question: string };
export function parseDutyInvocation(body: string): DutyInvocation | null {
    const command = /^\/cs(?:\s|$)/.test(body);
    const rest = command ? body.slice(3).trim() : body;
    if (rest.startsWith('#')) {
        const match = /^#([^\s]+)(?:\s+([\s\S]*))?$/.exec(rest);
        if (!match) return null;
        return { alias: normalizeDutyAlias(match[1]!), question: (match[2] ?? '').trim() };
    }
    return command ? { alias: null, question: rest } : null;
}
