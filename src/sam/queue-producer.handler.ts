import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const sqs = new SQSClient({});
const QUEUE_URL = process.env['QUEUE_URL'] ?? '';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  const messageId = crypto.randomUUID();
  const message = { id: messageId, ...body, sentAt: new Date().toISOString() };

  console.log('Sending to queue:', JSON.stringify(message));

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(message),
    }),
  );

  console.log('Message sent:', messageId);

  return {
    statusCode: 202,
    body: JSON.stringify({ messageId, status: 'queued' }),
  };
}
