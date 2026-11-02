import type { SessionToken } from './types.js';

/**
 * Generates a mock session token for a given user.
 */
export function generateToken(userId: string, expiresInMs: number = 3600000): SessionToken {
  if (!userId || userId.trim() === '') {
    throw new Error('Invalid User ID provided for token generation.');
  }

  // Simulate a unique token string (e.g., base64 or hex in a real app)
  const randomStr = Math.random().toString(36).substring(2, 10);

  return {
    token: `tok_${userId}_${randomStr}`,
    expiresAt: Date.now() + expiresInMs,
    isValid: true,
  };
}

/**
 * Validates a session token against current system time and its internal flag.
 */
export function validateToken(session: SessionToken): boolean {
  if (!session || !session.token) {
    return false;
  }

  if (Date.now() > session.expiresAt) {
    return false;
  }

  return session.isValid;
}
