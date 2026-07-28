import {
  normalizeProviderTargetBinding,
  type TranslationProviderId,
} from '@shinobu/shared-config';

export type ProviderSecretBinding = {
  providerId: TranslationProviderId;
  target: string;
};

export type ProviderSecretRestoreResult =
  | { status: 'missing' }
  | { status: 'restored'; secret: string }
  | { status: 'target-mismatch'; storedTarget: string }
  | { status: 'corrupt' };

export interface ProviderSecretVault {
  restore(binding: ProviderSecretBinding): Promise<ProviderSecretRestoreResult>;
  remember(binding: ProviderSecretBinding, secret: string): Promise<void>;
  forget(providerId: TranslationProviderId): Promise<void>;
}

export interface ProviderSecretStorageAdapter {
  loadDeviceKey(): Promise<CryptoKey | null>;
  saveDeviceKey(key: CryptoKey): Promise<void>;
  readCiphertext(providerId: TranslationProviderId): string | null;
  writeCiphertext(providerId: TranslationProviderId, value: string): void;
  removeCiphertext(providerId: TranslationProviderId): void;
}

type CiphertextRecord = {
  schemaVersion: 1;
  providerId: TranslationProviderId;
  target: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
};

const DATABASE_NAME = 'shinobu-secure-storage';
const DATABASE_VERSION = 1;
const DEVICE_KEY_STORE = 'device-keys';
const DEVICE_KEY_ID = 'provider-secrets-v1';
const CIPHERTEXT_PREFIX = 'shinobu:remembered-provider-key:v1:';
const AAD_PREFIX = 'shinobu-provider-secret:v1';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(
      request.error ?? new Error('IndexedDB 请求失败'),
    ), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(
      transaction.error ?? new Error('IndexedDB 事务已中止'),
    ), { once: true });
    transaction.addEventListener('error', () => reject(
      transaction.error ?? new Error('IndexedDB 事务失败'),
    ), { once: true });
  });
}

function openDeviceKeyDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        request.result.createObjectStore(DEVICE_KEY_STORE);
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(
      request.error ?? new Error('无法打开设备密钥存储'),
    ), { once: true });
    request.addEventListener('blocked', () => reject(
      new Error('设备密钥存储升级被其他页面阻塞'),
    ), { once: true });
  });
}

export class BrowserProviderSecretStorage implements ProviderSecretStorageAdapter {
  async loadDeviceKey(): Promise<CryptoKey | null> {
    const database = await openDeviceKeyDatabase();
    try {
      const transaction = database.transaction(DEVICE_KEY_STORE, 'readonly');
      const value = await requestResult(
        transaction.objectStore(DEVICE_KEY_STORE).get(DEVICE_KEY_ID),
      );
      return value instanceof CryptoKey ? value : null;
    } finally {
      database.close();
    }
  }

  async saveDeviceKey(key: CryptoKey): Promise<void> {
    const database = await openDeviceKeyDatabase();
    try {
      const transaction = database.transaction(DEVICE_KEY_STORE, 'readwrite');
      transaction.objectStore(DEVICE_KEY_STORE).put(key, DEVICE_KEY_ID);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  readCiphertext(providerId: TranslationProviderId): string | null {
    return localStorage.getItem(`${CIPHERTEXT_PREFIX}${providerId}`);
  }

  writeCiphertext(providerId: TranslationProviderId, value: string): void {
    localStorage.setItem(`${CIPHERTEXT_PREFIX}${providerId}`, value);
  }

  removeCiphertext(providerId: TranslationProviderId): void {
    localStorage.removeItem(`${CIPHERTEXT_PREFIX}${providerId}`);
  }
}

export class MemoryProviderSecretStorage implements ProviderSecretStorageAdapter {
  deviceKey: CryptoKey | null = null;
  readonly ciphertext = new Map<TranslationProviderId, string>();

  async loadDeviceKey(): Promise<CryptoKey | null> {
    return this.deviceKey;
  }

  async saveDeviceKey(key: CryptoKey): Promise<void> {
    this.deviceKey = key;
  }

  readCiphertext(providerId: TranslationProviderId): string | null {
    return this.ciphertext.get(providerId) ?? null;
  }

  writeCiphertext(providerId: TranslationProviderId, value: string): void {
    this.ciphertext.set(providerId, value);
  }

  removeCiphertext(providerId: TranslationProviderId): void {
    this.ciphertext.delete(providerId);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseCiphertextRecord(value: string | null): CiphertextRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CiphertextRecord>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.providerId !== 'string'
      || typeof parsed.target !== 'string'
      || typeof parsed.iv !== 'string'
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return parsed as CiphertextRecord;
  } catch {
    return null;
  }
}

function additionalData(binding: ProviderSecretBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `${AAD_PREFIX}:${binding.providerId}:${binding.target}`,
  );
}

async function getOrCreateDeviceKey(
  storage: ProviderSecretStorageAdapter,
  cryptoImpl: Crypto,
): Promise<CryptoKey> {
  const existing = await storage.loadDeviceKey();
  if (existing) return existing;
  const key = await cryptoImpl.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await storage.saveDeviceKey(key);
  return key;
}

export function createProviderSecretBinding(
  providerId: TranslationProviderId,
  baseUrl: string,
): ProviderSecretBinding {
  return {
    providerId,
    target: normalizeProviderTargetBinding(baseUrl),
  };
}

export function createProviderSecretVault(
  storage: ProviderSecretStorageAdapter = new BrowserProviderSecretStorage(),
  cryptoImpl: Crypto = crypto,
): ProviderSecretVault {
  return {
    async restore(binding) {
      const raw = storage.readCiphertext(binding.providerId);
      if (!raw) return { status: 'missing' };
      const record = parseCiphertextRecord(raw);
      if (!record || record.providerId !== binding.providerId) {
        return { status: 'corrupt' };
      }
      if (record.target !== binding.target) {
        return {
          status: 'target-mismatch',
          storedTarget: record.target,
        };
      }
      const key = await storage.loadDeviceKey();
      if (!key) return { status: 'corrupt' };
      try {
        const plaintext = await cryptoImpl.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64(record.iv),
            additionalData: additionalData(binding),
          },
          key,
          fromBase64(record.ciphertext),
        );
        return {
          status: 'restored',
          secret: new TextDecoder().decode(plaintext),
        };
      } catch {
        return { status: 'corrupt' };
      }
    },

    async remember(binding, secret) {
      const normalizedSecret = secret.trim();
      if (!normalizedSecret) throw new Error('API Key 不能为空');
      const key = await getOrCreateDeviceKey(storage, cryptoImpl);
      const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
      const ciphertext = await cryptoImpl.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: additionalData(binding),
        },
        key,
        new TextEncoder().encode(normalizedSecret),
      );
      const record: CiphertextRecord = {
        schemaVersion: 1,
        providerId: binding.providerId,
        target: binding.target,
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
        createdAt: new Date().toISOString(),
      };
      storage.writeCiphertext(binding.providerId, JSON.stringify(record));
    },

    async forget(providerId) {
      storage.removeCiphertext(providerId);
    },
  };
}
