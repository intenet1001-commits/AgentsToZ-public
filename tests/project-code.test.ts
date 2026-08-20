import { test, expect } from 'bun:test';
import { projectCode } from '../src/projectCode';

test('takes the first UUID segment, uppercased', () => {
  expect(projectCode('3f9a1c2e-4b5d-4e8f-9a1b-2c3d4e5f6a7b')).toBe('3F9A1C2E');
});

test('is deterministic for the same id', () => {
  const id = crypto.randomUUID();
  expect(projectCode(id)).toBe(projectCode(id));
});

test('falls back to the whole value for a non-UUID id', () => {
  expect(projectCode('single-abc123')).toBe('SINGLE');
  expect(projectCode('plainid')).toBe('PLAINID');
});

test('different projects get different codes in practice', () => {
  const codes = new Set(Array.from({ length: 200 }, () => projectCode(crypto.randomUUID())));
  expect(codes.size).toBe(200);
});
