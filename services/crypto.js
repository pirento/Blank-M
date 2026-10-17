/**
 * Encryption helpers: AES-256-GCM for broker tokens and authenticator secrets,
 * and SHA-256 hashing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ServerConfigurationError } from './errors.js';

function configuredKey() {
  const value = process.env.BROKER_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new ServerConfigurationError('BROKER_TOKEN_ENCRYPTION_KEY is not configured.');
  return value;
}

/** Production writes require an explicit 32-byte key format; format cannot prove randomness. */
export function assertBrokerEncryptionWriteReady() {
  const value = configuredKey();
  if (process.env.NODE_ENV !== 'production') return;
  const hex = /^[a-fA-F0-9]{64}$/.test(value);
  const base64 = Buffer.from(value, 'base64');
  const encoded =
    base64.length === 32 &&
    (base64.toString('base64') === value || base64.toString('base64url') === value);
  if (!hex && !encoded)
    throw new ServerConfigurationError(
      'New broker connections require a randomly generated 32-byte encryption key encoded as hex, base64, or base64url. Configure an operator-reviewed rotation and reconnect existing accounts.',
    );
}

function encryptionKey() {
  const value = configuredKey();
  // Preserve the original string derivation: decoding an existing value here
  // would make all historical ciphertext unreadable, including strong keys.
  return createHash('sha256').update(value).digest();
}

/**
 * Encrypts a broker token with AES-256-GCM, returning base64 `{ ciphertext, iv, tag }`. Throws
 * ServerConfigurationError when the encryption key is missing or, in production, badly formatted.
 */
export function encryptSecret(value) {
  assertBrokerEncryptionWriteReady();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a value from encryptSecret. Throws if the key is missing or the ciphertext was altered.
 */
export function decryptSecret(value) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(value.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Authenticator secrets use a key derived from SESSION_SECRET (or the broker key)
 * so they are never stored in plaintext. Domain separation keeps the two uses apart.
 */
function mfaKey() {
  const base = process.env.MFA_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (!base) {
    if (process.env.NODE_ENV === 'production')
      throw new ServerConfigurationError('SESSION_SECRET is required for authenticator setup.');
    return createHash('sha256').update('blank-mfa-development-only').digest();
  }
  return createHash('sha256').update(`blank-mfa-v1\0${base}`).digest();
}

/**
 * Encrypts an authenticator secret with AES-256-GCM under the MFA key, returning base64 `{
 * ciphertext, iv, tag }`.
 */
export function encryptMfaSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a value from encryptMfaSecret. Throws if the ciphertext was altered or the key changed.
 */
export function decryptMfaSecret(value) {
  const decipher = createDecipheriv('aes-256-gcm', mfaKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Hex SHA-256 digest of a string or buffer. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
