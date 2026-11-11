import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Pool } from 'pg';

const REGION = process.env['AWS_REGION'] ?? 'eu-west-2';
const CLUSTER_ENDPOINT = process.env['DSQL_CLUSTER_ENDPOINT'] ?? '';
const KMS_KEY_ID = process.env['KMS_KEY_ID'] ?? '';
// Set by `dev sam:start` to the DSQL emulator; unset when deployed.
const LOCAL_ENDPOINT = process.env['DSQL_LOCAL_ENDPOINT'];

const kms = new KMSClient({});

interface ItemRow {
  id: string;
  data: string;
  secret_ciphertext: string | null;
  created_at: string;
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;

  const host = LOCAL_ENDPOINT ?? CLUSTER_ENDPOINT;
  const signer =
    LOCAL_ENDPOINT === undefined ? new DsqlSigner({ hostname: host, region: REGION }) : undefined;

  pool = new Pool({
    host,
    port: 5432,
    database: 'postgres',
    user: 'admin',
    // IAM tokens expire, so one is minted per new connection. The emulator accepts any token.
    password: async () => (signer === undefined ? 'local' : signer.getDbConnectAdminAuthToken()),
    // Verified TLS against the real cluster. The local emulator gets a plain connection:
    // its certificate is self-signed, so unverified TLS would add no protection.
    ssl: LOCAL_ENDPOINT === undefined ? { rejectUnauthorized: true } : false,
    max: 1,
  });
  return pool;
}

// The item id is bound into the ciphertext, so a value copied onto another row will not decrypt.
async function encryptSecret(id: string, secret: string): Promise<string> {
  const { CiphertextBlob } = await kms.send(
    new EncryptCommand({
      KeyId: KMS_KEY_ID,
      Plaintext: Buffer.from(secret),
      EncryptionContext: { item: id },
    }),
  );

  if (!CiphertextBlob) {
    throw new Error(
      `Failed to encrypt secret for item "${id}": KMS response did not contain a CiphertextBlob.`,
    );
  }

  return Buffer.from(CiphertextBlob).toString('base64');
}

async function decryptSecret(id: string, ciphertext: string): Promise<string> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, 'base64'),
      EncryptionContext: { item: id },
    }),
  );

  if (!Plaintext) {
    throw new Error(
      `Failed to decrypt secret for item "${id}": KMS response did not contain Plaintext.`,
    );
  }

  return Buffer.from(Plaintext).toString('utf8');
}

// Example output only: shows the stored ciphertext beside the plaintext so you can see the
// field really is encrypted. A real API should not hand back the decrypted secret.
async function toItem(row: ItemRow) {
  const secret =
    row.secret_ciphertext === null
      ? {}
      : {
          secret: {
            encrypted: row.secret_ciphertext,
            decrypted: await decryptSecret(row.id, row.secret_ciphertext),
          },
        };
  return {
    id: row.id,
    ...(JSON.parse(row.data) as Record<string, unknown>),
    ...secret,
    createdAt: row.created_at,
  };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.['id'];
  const db = getPool();

  try {
    if (event.httpMethod === 'GET' && !id) {
      const { rows } = await db.query<ItemRow>('SELECT * FROM items ORDER BY created_at');
      return { statusCode: 200, body: JSON.stringify(await Promise.all(rows.map(toItem))) };
    }

    if (event.httpMethod === 'GET' && id) {
      const { rows } = await db.query<ItemRow>('SELECT * FROM items WHERE id = $1', [id]);
      const [row] = rows;
      if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, body: JSON.stringify(await toItem(row)) };
    }

    if (event.httpMethod === 'POST') {
      const { secret, ...body } = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
      const itemId = typeof body['id'] === 'string' ? body['id'] : crypto.randomUUID();
      const ciphertext = typeof secret === 'string' ? await encryptSecret(itemId, secret) : null; // pragma: allowlist secret

      const { rows } = await db.query<ItemRow>(
        'INSERT INTO items (id, data, secret_ciphertext) VALUES ($1, $2, $3) RETURNING *',
        [itemId, JSON.stringify(body), ciphertext],
      );

      const createdRow = rows[0];
      if (!createdRow) {
        throw new Error(`Failed to insert item with ID "${itemId}": Database returned no rows.`);
      }

      const item = await toItem(createdRow);
      return {
        statusCode: 201,
        body: JSON.stringify(item),
      };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('Request failed:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}
