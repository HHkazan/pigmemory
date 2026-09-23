import sodium from "libsodium-wrappers";

export async function decryptOwnTracksPayload(
  payload: string,
  secret: string,
): Promise<Record<string, unknown>> {
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(payload);
  } catch {
    throw new Error("invalid encrypted payload JSON");
  }
  if (!isRecord(wrapper) || wrapper._type !== "encrypted" || typeof wrapper.data !== "string") {
    throw new Error("payload is not an OwnTracks encrypted envelope");
  }
  await sodium.ready;
  const packed = Buffer.from(wrapper.data, "base64");
  if (packed.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
    throw new Error("encrypted payload is too short");
  }
  const key = ownTracksKey(secret);
  try {
    const nonce = packed.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = packed.subarray(sodium.crypto_secretbox_NONCEBYTES);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    const value: unknown = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    if (!isRecord(value)) throw new Error("decrypted payload must be an object");
    return value;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error("decrypted payload is not valid JSON");
    throw new Error("OwnTracks payload authentication failed");
  } finally {
    sodium.memzero(key);
  }
}

export function ownTracksKey(secret: string): Uint8Array {
  const bytes = Buffer.from(secret, "utf8");
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error("OwnTracks encryption key must be 1 to 32 UTF-8 bytes");
  }
  const key = new Uint8Array(32);
  key.set(bytes);
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
