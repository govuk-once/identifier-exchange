import type { SQSEvent } from 'aws-lambda';

export async function handler(event: SQSEvent): Promise<void> {
  console.log(`Consumer received ${event.Records.length} message(s)`);

  for (const record of event.Records) {
    const body = JSON.parse(record.body) as Record<string, unknown>;
    console.log('Processing message:', JSON.stringify(body));
    console.log('  messageId:', record.messageId);
    console.log('  body.action:', body['action'] ?? '(none)');
  }

  console.log('All messages processed');
}
