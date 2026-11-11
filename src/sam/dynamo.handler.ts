import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const kms = new KMSClient({});
const TABLE_NAME = process.env['TABLE_NAME'] ?? '';
const KMS_KEY_ID = process.env['KMS_KEY_ID'] ?? '';

// The item id is bound into the ciphertext, so a value copied onto another item will not decrypt.
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
async function toResponse({ secretCiphertext, ...item }: Record<string, unknown>) {
  if (typeof secretCiphertext !== 'string') return item; // pragma: allowlist secret
  const decrypted = await decryptSecret(item['pk'] as string, secretCiphertext);
  return { ...item, secret: { encrypted: secretCiphertext, decrypted } };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const id = event.pathParameters?.['id'];

  if (method === 'GET' && !id) {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
    const items = await Promise.all((result.Items ?? []).map(toResponse));
    return { statusCode: 200, body: JSON.stringify(items) };
  }

  if (method === 'GET' && id) {
    const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: id } }));
    if (!result.Item) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    return { statusCode: 200, body: JSON.stringify(await toResponse(result.Item)) };
  }

  if (method === 'POST') {
    const { secret, ...body } = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    const pk = typeof body['id'] === 'string' ? body['id'] : crypto.randomUUID();
    const item = {
      pk,
      ...body,
      ...(typeof secret === 'string' ? { secretCiphertext: await encryptSecret(pk, secret) } : {}), // pragma: allowlist secret
      createdAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    return { statusCode: 201, body: JSON.stringify(await toResponse(item)) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
}
