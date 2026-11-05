import { expect, test } from 'bun:test';
import { clipboard } from './src/lib/browserHealth';

const readText = async () => {
  throw new Error('the check must not read the clipboard');
};

function nav(query: () => Promise<{ state: string }>, api: object = { readText }) {
  return { clipboard: api, permissions: { query } } as unknown as Pick<Navigator, 'clipboard' | 'permissions'>;
}

test('a denied clipboard permission is blocked', async () => {
  const result = await clipboard(nav(async () => ({ state: 'denied' })));
  expect(result.status).toBe('warning');
  expect(result.value).toBe('Blocked');
  expect(result.note).toContain('site settings');
});

test('a granted or undecided clipboard permission is available', async () => {
  for (const state of ['granted', 'prompt']) {
    const result = await clipboard(nav(async () => ({ state })));
    expect(result.status).toBe('ok');
  }
});

test('browsers that cannot answer fall back to the API check', async () => {
  const rejects = nav(async () => {
    throw new TypeError('unknown permission');
  });
  expect((await clipboard(rejects)).status).toBe('ok');
  const noPermissions = { clipboard: { readText } } as unknown as Pick<Navigator, 'clipboard' | 'permissions'>;
  expect((await clipboard(noPermissions)).status).toBe('ok');
});

test('a missing clipboard API is blocked', async () => {
  const result = await clipboard(nav(async () => ({ state: 'granted' }), {}));
  expect(result.status).toBe('warning');
  expect(result.value).toBe('Blocked');
});
