import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateToken, validateToken } from './index.js';

describe('Identity Session API', () => {
  const MOCK_DATE = new Date('2026-09-19T10:00:00Z');
  const MOCK_TIME_MS = MOCK_DATE.getTime();

  beforeEach(() => {
    // Lock the system time so Date.now() is perfectly predictable
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateToken', () => {
    it('creates a token with default 1-hour expiration', () => {
      const session = generateToken('usr_123');

      expect(session.token).toMatch(/^tok_usr_123_[a-z0-9]+$/);
      expect(session.isValid).toBe(true);
      // Base time + 1 hour (3600000 ms)
      expect(session.expiresAt).toBe(MOCK_TIME_MS + 3600000);
    });

    it('creates a token with custom expiration', () => {
      const session = generateToken('usr_123', 5000); // 5 seconds
      expect(session.expiresAt).toBe(MOCK_TIME_MS + 5000);
    });

    it('throws an error if the userId is empty or whitespace', () => {
      expect(() => generateToken('')).toThrow('Invalid User ID provided');
      expect(() => generateToken('   ')).toThrow('Invalid User ID provided');
    });
  });

  describe('validateToken', () => {
    it('returns true for a newly generated, valid token', () => {
      const session = generateToken('usr_123');
      expect(validateToken(session)).toBe(true);
    });

    it('returns false if the token is flagged as invalid', () => {
      const session = generateToken('usr_123');
      session.isValid = false;

      expect(validateToken(session)).toBe(false);
    });

    it('returns false if the token has expired', () => {
      // Generate a token that expires in 1 hour
      const session = generateToken('usr_123');

      // Fast-forward time by 2 hours
      vi.advanceTimersByTime(7200000);

      expect(validateToken(session)).toBe(false);
    });

    it('returns false if an incomplete or null object is passed', () => {
      // @ts-expect-error - intentionally testing invalid inputs
      expect(validateToken(null)).toBe(false);
      // @ts-expect-error - intentionally testing invalid inputs
      expect(validateToken({})).toBe(false);
    });
  });
});
