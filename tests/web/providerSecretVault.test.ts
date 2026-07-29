import { describe, expect, it } from 'vitest';
import {
  createProviderSecretBinding,
  createProviderSecretVault,
  MemoryProviderSecretStorage,
} from '../../apps/web/src/security/providerSecretVault';

describe('provider secret vault Module', () => {
  it('encrypts a target-bound secret with a non-exportable device key', async () => {
    const storage = new MemoryProviderSecretStorage();
    const vault = createProviderSecretVault(storage);
    const binding = createProviderSecretBinding(
      'deepseek',
      'https://API.DeepSeek.com:443/v1/',
    );

    await vault.remember(binding, 'sk-device-secret');

    const serialized = storage.ciphertext.get('deepseek') ?? '';
    expect(serialized).not.toContain('sk-device-secret');
    expect(binding.target).toBe('https://api.deepseek.com/v1');
    await expect(vault.restore(binding)).resolves.toEqual({
      status: 'restored',
      secret: 'sk-device-secret',
    });
    await expect(
      crypto.subtle.exportKey('raw', storage.deviceKey!),
    ).rejects.toThrow();
  });

  it('refuses to decrypt a remembered key for a changed host or path prefix', async () => {
    const storage = new MemoryProviderSecretStorage();
    const vault = createProviderSecretVault(storage);
    await vault.remember(
      createProviderSecretBinding('custom', 'https://one.example/v1'),
      'sk-one',
    );

    await expect(vault.restore(
      createProviderSecretBinding('custom', 'https://one.example/v2'),
    )).resolves.toMatchObject({
      status: 'target-mismatch',
      storedTarget: 'https://one.example/v1',
    });
    await expect(vault.restore(
      createProviderSecretBinding('custom', 'https://two.example/v1'),
    )).resolves.toMatchObject({
      status: 'target-mismatch',
    });
  });

  it('reports tampering and deletes only the selected provider ciphertext', async () => {
    const storage = new MemoryProviderSecretStorage();
    const vault = createProviderSecretVault(storage);
    const deepseek = createProviderSecretBinding('deepseek', 'https://api.deepseek.com');
    const openai = createProviderSecretBinding('openai', 'https://api.openai.com/v1');
    await vault.remember(deepseek, 'sk-deepseek');
    await vault.remember(openai, 'sk-openai');
    const tampered = JSON.parse(storage.ciphertext.get('deepseek') ?? '{}') as {
      ciphertext?: string;
    };
    const originalCiphertext = tampered.ciphertext ?? '';
    tampered.ciphertext = `${originalCiphertext.startsWith('A') ? 'B' : 'A'}${
      originalCiphertext.slice(1)
    }`;
    storage.ciphertext.set('deepseek', JSON.stringify(tampered));

    await expect(vault.restore(deepseek)).resolves.toEqual({ status: 'corrupt' });
    await vault.forget('deepseek');
    await expect(vault.restore(deepseek)).resolves.toEqual({ status: 'missing' });
    await expect(vault.restore(openai)).resolves.toMatchObject({
      status: 'restored',
      secret: 'sk-openai',
    });
  });
});
