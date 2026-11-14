// The tool's own key material. See docs/adr/0015 in the Tessil docs: an
// access key is a device with a token, a key pair and a secret of its own.

import { base64UrlToBytes, bytesToBase64Url } from "@tessil/core/crypto/base64url";
import { publicKeyFingerprint } from "@tessil/core/vault/keypair";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const WRAP_CONTEXT = "tessil/device-transfer-wrap/v1";
const IV_BYTES = 12;

const encoder = new TextEncoder();
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export interface NewDevice {
  token: string;
  tokenHash: string;
  privateKey: string;
  publicKey: string;
  secret: string;
  fingerprint: string;
}

export async function newDevice(): Promise<NewDevice> {
  const token = `tsl_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(encoder.encode(token))));
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    token,
    tokenHash: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    privateKey: bytesToBase64Url(pkcs8),
    publicKey: bytesToBase64Url(publicKey),
    secret: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    fingerprint: await publicKeyFingerprint(publicKey),
  };
}

async function wrappingKey(secret: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", buf(base64UrlToBytes(secret)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(WRAP_CONTEXT) },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Bound to the device and the transfer, so a wrap cannot be moved to another row.
const aad = (deviceId: string, transferId: string) => buf(encoder.encode(`${WRAP_CONTEXT}|${deviceId}|${transferId}`));

/**
 * A transfer's key, wrapped under this device's secret: iv(12) || ciphertext(32) || tag(16).
 * The server stores it and cannot open it. It is how `tessil list` shows names.
 */
export async function wrapTransferKey(
  secret: string,
  deviceId: string,
  transferId: string,
  rawKey: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: aad(deviceId, transferId) },
    await wrappingKey(secret),
    buf(rawKey),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return bytesToBase64Url(out);
}

/** Null when the wrap was not made by this device for this transfer. */
export async function unwrapTransferKey(
  secret: string,
  deviceId: string,
  transferId: string,
  wrapped: string,
): Promise<Uint8Array | null> {
  try {
    const bytes = base64UrlToBytes(wrapped);
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(bytes.subarray(0, IV_BYTES)), additionalData: aad(deviceId, transferId) },
      await wrappingKey(secret),
      buf(bytes.subarray(IV_BYTES)),
    );
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}
