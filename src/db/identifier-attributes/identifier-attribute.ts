import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { toIsoString } from '../to-iso-string.js';

/**
 * An identifier_attributes row as the pg driver returns it (snake_case
 * columns). Schema: src/db/schema/identifier_attributes.sql.
 */
export interface IdentifierAttributeDSQL {
  id: string;
  /** linked_identifiers.id */
  linked_identifier_id: string;
  name: string;
  /** Encrypted: base64(iv ‖ authTag ‖ ciphertext). */
  value: string;
  /** The data key that encrypted `value`, wrapped by KMS, base64. */
  data_key: string;
  created_at: Date | string;
}

/**
 * An identifier_attributes row as handlers and domain logic see it
 * (camelCase). `value` is still encrypted: use decryptValue() to read it.
 */
export interface IdentifierAttribute {
  id: string;
  linkedIdentifierId: string;
  name: string;
  value: string;
  dataKey: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** What to write to the value and data_key columns. */
export interface EncryptedAttributeValue {
  value: string;
  dataKey: string;
}

/** The fields decryption needs: the ciphertext and the row it belongs to. */
export type EncryptedAttribute = Pick<
  IdentifierAttribute,
  'linkedIdentifierId' | 'name' | 'value' | 'dataKey'
>;

export interface IdentifierAttributeDtoOptions {
  kms: KMSClient;
  /** The data encryption key (NetworkSecurityStack's dataEncryptionKey): ID, ARN or alias. */
  keyId: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * KMS encryption context. It binds each wrapped data key to the attribute it
 * was made for, so a value and data_key copied onto another row or renamed
 * fail to decrypt. It is logged in CloudTrail: never put the value in it.
 */
const encryptionContext = (linkedIdentifierId: string, name: string) => ({
  linked_identifier_id: linkedIdentifierId,
  name,
});

/**
 * Maps identifier_attributes rows between snake_case and camelCase, and
 * encrypts and decrypts attribute values with envelope encryption: a fresh
 * KMS data key per value, used locally for AES-256-GCM and stored wrapped in
 * data_key. The plaintext data key is zeroed as soon as it has been used.
 */
export class IdentifierAttributeDto {
  private readonly kms: KMSClient;
  private readonly keyId: string;

  constructor({ kms, keyId }: IdentifierAttributeDtoOptions) {
    if (!keyId) {
      throw new Error('IdentifierAttributeDto needs a KMS key ID');
    }
    this.kms = kms;
    this.keyId = keyId;
  }

  /** Maps a database row to the camelCase DTO. `value` stays encrypted. */
  static fromRow(row: IdentifierAttributeDSQL): IdentifierAttribute {
    return {
      id: row.id,
      linkedIdentifierId: row.linked_identifier_id,
      name: row.name,
      value: row.value,
      dataKey: row.data_key,
      createdAt: toIsoString(row.created_at, 'identifier_attributes.created_at'),
    };
  }

  static fromRows(rows: readonly IdentifierAttributeDSQL[]): IdentifierAttribute[] {
    return rows.map((row) => IdentifierAttributeDto.fromRow(row));
  }

  /** Encrypts an attribute value for the given linked identifier and name. */
  async encryptValue(
    linkedIdentifierId: string,
    name: string,
    plaintext: string,
  ): Promise<EncryptedAttributeValue> {
    const { Plaintext: key, CiphertextBlob: wrappedKey } = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: encryptionContext(linkedIdentifierId, name),
      }),
    );
    if (!key || !wrappedKey) {
      key?.fill(0);
      throw new Error('KMS GenerateDataKey did not return key material');
    }

    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

      return {
        value: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'),
        dataKey: Buffer.from(wrappedKey).toString('base64'),
      };
    } finally {
      key.fill(0);
    }
  }

  /**
   * Decrypts an attribute's value. Fails if the value or data key has been
   * altered, or belongs to a different linked identifier or name.
   */
  async decryptValue({
    linkedIdentifierId,
    name,
    value,
    dataKey,
  }: EncryptedAttribute): Promise<string> {
    const packed = Buffer.from(value, 'base64');
    if (packed.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new Error(`Encrypted value for attribute "${name}" is too short to be valid`);
    }

    const { Plaintext: key } = await this.kms.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(dataKey, 'base64'),
        // Pinning the key stops a data key wrapped under some other KMS key
        // (one an attacker controls) from being accepted.
        KeyId: this.keyId,
        EncryptionContext: encryptionContext(linkedIdentifierId, name),
      }),
    );
    if (!key) {
      throw new Error('KMS Decrypt did not return the data key');
    }

    try {
      const iv = packed.subarray(0, IV_BYTES);
      const authTag = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAuthTag(authTag);

      return Buffer.concat([
        decipher.update(packed.subarray(IV_BYTES + AUTH_TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } finally {
      key.fill(0);
    }
  }
}
