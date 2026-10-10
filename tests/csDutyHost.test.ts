import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCsDutyStore, dutyMessages } from '../src/csDutyHost';
import { CsDuty, type DutyConfig, type DutyHost } from '../src/csDuty';

test('project settings and FAQ survive real disk reload; restart does not restore automatic-send consent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-duty-restart-'));
    const config: DutyConfig = {
        targetId: 'project-disk-one', revision: 0, profileLabel: 'fixture bot',
        chatId: 'chat_fixture', chatTitle: 'fixture room', knowledge: 'Public fixture instructions',
        faqs: [{ question: 'Hours?', answer: '9 to 5' }], provider: 'claude',
        modelId: 'claude-haiku-4-5', autoFaq: true, aiEnabled: false, dailyAiLimit: 7,
    };
    const makeHost = (): DutyHost => ({
        ...createCsDutyStore(root), now: () => 100000000, resolve: async id => id,
        resolvePath: async () => '/tmp', documents: async () => [], documentText: async () => '',
        discover: async () => [], binding: async () => 'fixture-binding',
        read: async c => ({ chatTitle: c.chatTitle, messages: [] }), diagnose: async () => [],
        answer: async () => { throw Error('No AI permitted'); },
        send: async () => { throw Error('No messages permitted'); },
    });
    try {
        const first = new CsDuty(makeHost());
        await first.configure(config);
        await first.configure({ ...config, targetId: 'project-disk-two', chatId: 'chat_other', profileLabel: 'second bot' });
        await first.enable(config.targetId, 1, true);
        expect(first.status(config.targetId).state).toBe('on');
        await first.shutdown();
        const restarted = new CsDuty(makeHost());
        expect(restarted.status(config.targetId).config).toEqual({ ...config, revision: 1 });
        expect(restarted.status(config.targetId).state).toBe('off');
        expect(restarted.status('project-disk-two').config?.profileLabel).toBe('second bot');
        expect(restarted.status('project-disk-new').config).toBeNull();
        await expect(restarted.configure(config)).rejects.toThrow('다른 화면');
        expect(new CsDuty(makeHost()).status(config.targetId).config).toEqual({ ...config, revision: 1 });
        await restarted.shutdown();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('duty storage persists only explicit state with private permissions and rejects symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-duty-store-'));
    try {
        const store = createCsDutyStore(root), state = { configs: [], usage: [], clock: 123 };
        expect(store.load().clock).toBe(0);
        store.save(state);
        expect(store.load()).toEqual(state);
        expect(statSync(join(root, 'cs-duty')).mode & 0o777).toBe(0o700);
        expect(statSync(join(root, 'cs-duty/settings.json')).mode & 0o777).toBe(0o600);
        rmSync(join(root, 'cs-duty/settings.json'));
        writeFileSync(join(root, 'other.json'), '{}');
        symlinkSync(join(root, 'other.json'), join(root, 'cs-duty/settings.json'));
        expect(() => store.load()).toThrow();
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('duty adapter refuses wrong room, malformed/oversized messages and retains attachment exclusion', () => {
    expect(() => dutyMessages({ chat: 'wrong', messages: [] }, 'support')).toThrow();
    expect(() => dutyMessages({ chat: 'support', messages: [{ author: 'a', body: 'x'.repeat(16001) }] }, 'support')).toThrow();
    expect(() => dutyMessages({ chat: 'support', messages: Array(51).fill({ author: 'a', body: 'x' }) }, 'support')).toThrow();
    const result = dutyMessages({ chat: 'support', messages: [{ author: 'a', body: '/cs hi', has_image: true }] }, 'support');
    expect(result.messages[0].attachment).toBe(true);
});
