/**
 * Signs a parameter map using Ed25519 for Binance API authentication.
 * Parameters are sorted alphabetically by key, joined as key=value pairs with &.
 * The signature is returned as a base64 string.
 *
 * Uses Web Crypto API (available in Bun natively).
 * Note: signPayload is async because Web Crypto sign() is async.
 */
export async function signPayload(
  params: Record<string, string | number>,
  privateKeyPem: string,
): Promise<string> {
  const queryString = buildQueryString(params);
  const encoder = new TextEncoder();
  const data = encoder.encode(queryString);

  // Import the Ed25519 private key
  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey('pkcs8', keyData, 'Ed25519', false, ['sign']);

  // Sign the payload
  const signature = await crypto.subtle.sign('Ed25519', key, data);

  // Convert to base64
  return arrayBufferToBase64(signature);
}

/**
 * Builds a query string from params, sorted alphabetically by key.
 * This is the payload that gets signed.
 */
export function buildQueryString(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/**
 * Adds timestamp and signature to a parameter map.
 * Returns the full signed parameter map ready for API request.
 */
export async function signRequest(
  params: Record<string, string | number>,
  privateKeyPem: string,
  recvWindow?: number,
): Promise<Record<string, string | number>> {
  const signed: Record<string, string | number> = { ...params, timestamp: Date.now() };
  if (recvWindow !== undefined) {
    signed.recvWindow = recvWindow;
  }
  signed.signature = await signPayload(signed, privateKeyPem);
  return signed;
}

// === Internal helpers ===

function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Strip PEM header/footer and whitespace
  const base64 = pem
    .replace(/-----BEGIN [\w\s]+-----/, '')
    .replace(/-----END [\w\s]+-----/, '')
    .replace(/\s/g, '');
  return base64ToArrayBuffer(base64);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(0);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
