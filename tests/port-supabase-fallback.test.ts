import { describe, expect, test } from 'bun:test';
import { retryPortUpsertWithoutMissingOptionalColumns } from '../src/portSupabaseFallback';

const initialRow = {
  id: 'project-1',
  name: 'Project',
  github_url: 'https://github.com/acme/app',
  github_urls: ['https://github.com/acme/app', 'https://github.com/acme/docs'],
  manual_path: '/docs/manual.md',
  log_file_path: '/docs/logs.md',
  device_id: 'device-1',
  device_name: 'My Mac',
};

describe('Supabase optional port-column fallback', () => {
  test('retries every missing group when document paths are reported before GitHub URLs', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const errors = [
      { message: "Could not find the 'manual_path' column" },
      { message: "Could not find the 'github_urls' column" },
      null,
    ];
    const result = await retryPortUpsertWithoutMissingOptionalColumns(
      [initialRow],
      async rows => {
        attempts.push(rows[0]!);
        return { error: errors.shift() ?? null };
      },
    );

    expect(result.error).toBeNull();
    expect(result.omittedColumns).toEqual(['manual_path', 'log_file_path', 'github_urls']);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).not.toHaveProperty('manual_path');
    expect(attempts[1]).not.toHaveProperty('log_file_path');
    expect(attempts[1]).toHaveProperty('github_urls');
    expect(attempts[2]).not.toHaveProperty('github_urls');
  });

  test('retries every missing group when GitHub URLs are reported before document paths', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const errors = [
      { message: "Could not find the 'github_urls' column" },
      { message: "Could not find the 'log_file_path' column" },
      null,
    ];
    const result = await retryPortUpsertWithoutMissingOptionalColumns(
      [initialRow],
      async rows => {
        attempts.push(rows[0]!);
        return { error: errors.shift() ?? null };
      },
    );

    expect(result.error).toBeNull();
    expect(result.omittedColumns).toEqual(['github_urls', 'manual_path', 'log_file_path']);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).not.toHaveProperty('github_urls');
    expect(attempts[1]).toHaveProperty('manual_path');
    expect(attempts[2]).not.toHaveProperty('manual_path');
    expect(attempts[2]).not.toHaveProperty('log_file_path');
  });
});
