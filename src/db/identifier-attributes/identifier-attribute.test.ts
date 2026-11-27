// cspell:words dtos hvcn ünïcödé
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, test, vi } from 'vitest';
import { type IdentifierAttributeDSQL, IdentifierAttributeDto } from './identifier-attribute.js';

const KEY_ID = 'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555';
const LINKED_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Stands in for KMS: GenerateDataKey hands out a random key and an opaque
 * blob; Decrypt returns the key only for the same KeyId and encryption
 * context, as KMS does. Records the plaintext keys it handed out.
 */
const fakeKms = () => {
  const wrapped = new Map<string, { key: Buffer; keyId: string; context: unknown }>();
  const handedOut: Uint8Array[] = [];
  const kms = new KMSClient({ region: 'eu-west-2' });

  const send = vi.spyOn(kms, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof GenerateDataKeyCommand) {
      const key = randomBytes(32);
      const blob = randomUUID();
      wrapped.set(blob, {
        key,
        keyId: command.input.KeyId ?? '',
        context: command.input.EncryptionContext,
      });
      const plaintext = new Uint8Array(key);
      handedOut.push(plaintext);
      return { Plaintext: plaintext, CiphertextBlob: Buffer.from(blob) };
    }
    if (command instanceof DecryptCommand) {
      const entry = wrapped.get(Buffer.from(command.input.CiphertextBlob ?? []).toString());
      if (
        !entry ||
        entry.keyId !== command.input.KeyId ||
        !isDeepStrictEqual(entry.context, command.input.EncryptionContext)
      ) {
        throw new Error('InvalidCiphertextException');
      }
      const plaintext = new Uint8Array(entry.key);
      handedOut.push(plaintext);
      return { Plaintext: plaintext };
    }
    throw new Error('unexpected command');
  }) as never);

  return { kms, send, handedOut };
};

const row = (overrides: Partial<IdentifierAttributeDSQL> = {}): IdentifierAttributeDSQL => ({
  id: '0f0e0d0c-0b0a-4909-8807-060504030201',
  linked_identifier_id: LINKED_ID,
  name: 'att1',
  value: 'Y2lwaGVydGV4dA==',
  data_key: 'ZGF0YS1rZXk=',
  created_at: new Date('2026-11-26T15:22:08.000Z'),
  ...overrides,
});

describe('IdentifierAttributeDto.fromRow / fromRows', () => {
  test('maps every snake_case column to its camelCase field', () => {
    expect(IdentifierAttributeDto.fromRow(row())).toEqual({
      id: '0f0e0d0c-0b0a-4909-8807-060504030201',
      linkedIdentifierId: LINKED_ID,
      name: 'att1',
      value: 'Y2lwaGVydGV4dA==',
      dataKey: 'ZGF0YS1rZXk=',
      createdAt: '2026-11-26T15:22:08.000Z',
    });
  });

  test('normalises a string created_at to ISO 8601 UTC', () => {
    const dto = IdentifierAttributeDto.fromRow(row({ created_at: '2026-11-26 15:22:08+00' }));

    expect(dto.createdAt).toBe('2026-11-26T15:22:08.000Z');
  });

  test('maps each row, in order', () => {
    const dtos = IdentifierAttributeDto.fromRows([row({ name: 'att1' }), row({ name: 'att2' })]);

    expect(dtos.map((d) => d.name)).toEqual(['att1', 'att2']);
    expect(IdentifierAttributeDto.fromRows([])).toEqual([]);
  });
});

describe('IdentifierAttributeDto encryption', () => {
  test('decrypts what it encrypted', async () => {
    const dto = new IdentifierAttributeDto({ kms: fakeKms().kms, keyId: KEY_ID });
    const plaintext = 'AB 12 34 56 C — ünïcödé ✓';

    const encrypted = await dto.encryptValue(LINKED_ID, 'att1', plaintext);

    expect(
      await dto.decryptValue({ linkedIdentifierId: LINKED_ID, name: 'att1', ...encrypted }),
    ).toBe(plaintext);
  });

  test('stores neither the plaintext nor the same ciphertext twice', async () => {
    const dto = new IdentifierAttributeDto({ kms: fakeKms().kms, keyId: KEY_ID });

    const first = await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');
    const second = await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');

    expect(Buffer.from(first.value, 'base64').toString()).not.toContain('secret-value');
    expect(first.value).not.toBe(second.value);
    expect(first.dataKey).not.toBe(second.dataKey);
  });

  test('asks KMS for an AES-256 data key bound to the linked identifier and name', async () => {
    const { kms, send } = fakeKms();
    const dto = new IdentifierAttributeDto({ kms, keyId: KEY_ID });

    await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');

    const command = send.mock.calls[0]?.[0] as GenerateDataKeyCommand;
    expect(command.input).toEqual({
      KeyId: KEY_ID,
      KeySpec: 'AES_256',
      EncryptionContext: { linked_identifier_id: LINKED_ID, name: 'att1' },
    });
  });

  test('refuses a value moved to another attribute name or linked identifier', async () => {
    const dto = new IdentifierAttributeDto({ kms: fakeKms().kms, keyId: KEY_ID });
    const encrypted = await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');

    await expect(
      dto.decryptValue({ linkedIdentifierId: LINKED_ID, name: 'att2', ...encrypted }),
    ).rejects.toThrow();
    await expect(
      dto.decryptValue({ linkedIdentifierId: randomUUID(), name: 'att1', ...encrypted }),
    ).rejects.toThrow();
  });

  test('refuses a tampered value', async () => {
    const dto = new IdentifierAttributeDto({ kms: fakeKms().kms, keyId: KEY_ID });
    const encrypted = await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');
    const packed = Buffer.from(encrypted.value, 'base64');
    packed[packed.length - 1] = (packed.at(-1) ?? 0) ^ 1;

    await expect(
      dto.decryptValue({
        linkedIdentifierId: LINKED_ID,
        name: 'att1',
        dataKey: encrypted.dataKey,
        value: packed.toString('base64'),
      }),
    ).rejects.toThrow();
  });

  test('refuses a value too short to hold an IV and auth tag, without calling KMS', async () => {
    const { kms, send } = fakeKms();
    const dto = new IdentifierAttributeDto({ kms, keyId: KEY_ID });

    await expect(
      dto.decryptValue({
        linkedIdentifierId: LINKED_ID,
        name: 'att1',
        value: 'c2hvcnQ=',
        dataKey: 'eA==',
      }),
    ).rejects.toThrow('too short');
    expect(send).not.toHaveBeenCalled();
  });

  test('zeroes every plaintext data key after use', async () => {
    const { kms, handedOut } = fakeKms();
    const dto = new IdentifierAttributeDto({ kms, keyId: KEY_ID });

    const encrypted = await dto.encryptValue(LINKED_ID, 'att1', 'secret-value');
    await dto.decryptValue({ linkedIdentifierId: LINKED_ID, name: 'att1', ...encrypted });

    expect(handedOut).toHaveLength(2);
    for (const key of handedOut) expect(key.every((byte) => byte === 0)).toBe(true);
  });

  test('needs a key ID', () => {
    expect(() => new IdentifierAttributeDto({ kms: fakeKms().kms, keyId: '' })).toThrow(
      'KMS key ID',
    );
  });
});
