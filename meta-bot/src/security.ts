/**
 * Security module for Meta webhook signature verification
 * Uses HMAC SHA256 to validate X-Hub-Signature-256 header
 */

/**
 * Verifies Meta webhook signature using HMAC SHA256
 * @param req - The incoming request
 * @param appSecret - META_APP_SECRET from environment
 * @param rawBody - Raw request body as ArrayBuffer
 * @throws Error if signature is missing or invalid
 */
export async function verifyMetaSignatureOrThrow(
  req: Request,
  appSecret: string,
  rawBody: ArrayBuffer
): Promise<void> {
  // Extract X-Hub-Signature-256 header
  const signature = req.headers.get('X-Hub-Signature-256');
  
  if (!signature) {
    throw new Error('Missing X-Hub-Signature-256 header');
  }

  // Compute HMAC SHA256 of raw request body
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, rawBody);
  
  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  // Format as "sha256=<hex>"
  const expectedSignature = `sha256=${hashHex}`;

  // Timing-safe comparison
  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new Error('Invalid signature');
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks
 * @param a - First string
 * @param b - Second string
 * @returns true if strings are equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
