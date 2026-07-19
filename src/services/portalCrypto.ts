/**
 * AES-256-GCM encryption/decryption for portal session cookies.
 *
 * The symmetric key is sourced from the PORTAL_ENCRYPTION_KEY Worker secret,
 * which must be a 64-character lowercase hex string (32 bytes).
 *
 * Generate a key with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

function hexToBytes(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex key length");
  const buf = new ArrayBuffer(hex.length / 2);
  const view = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    view[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return buf;
}

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...Array.from(new Uint8Array(buf))));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buf;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(hexKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypted payload produced by `encryptData` and consumed by `decryptData`.
 * Both fields are base64-encoded to allow safe storage in D1 TEXT columns.
 */
export interface EncryptedPayload {
  /** AES-256-GCM ciphertext, base64-encoded. */
  ciphertext: string;
  /** 12-byte GCM Initialization Vector, base64-encoded. A fresh IV is generated per encryption. */
  iv: string;
}

/**
 * Encrypts `plaintext` using AES-256-GCM with a random IV.
 * Returns the ciphertext and IV as base64 strings.
 */
export async function encryptData(plaintext: string, hexKey: string): Promise<EncryptedPayload> {
  const key = await importKey(hexKey);
  const ivBuf = new ArrayBuffer(12);
  crypto.getRandomValues(new Uint8Array(ivBuf));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBuf },
    key,
    encoded
  );
  return {
    ciphertext: bufToBase64(encrypted),
    iv: bufToBase64(ivBuf),
  };
}

/**
 * Decrypts a payload previously produced by `encryptData`.
 * Throws if the key is wrong or the ciphertext is tampered with.
 */
export async function decryptData(payload: EncryptedPayload, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(payload.iv) },
    key,
    base64ToBuf(payload.ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}
