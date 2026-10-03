/**
 * A mock payload cipher. It is NOT cryptography: it XORs the plaintext with a
 * fixed test pad and base64-encodes the result, which is enough to prove that
 * the OMS persists ciphertext, never the signed payload in clear, and that the
 * persisted ciphertext round-trips. The key never leaves this test file.
 */

import type { EncryptedPayload, PayloadCipher } from "../../../../packages/oms/src/index.js";

const PAD = Buffer.from("wp-270-test-pad-not-a-key", "utf8");

function xor(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) out[index] = (bytes[index] as number) ^ (PAD[index % PAD.length] as number);
  return out;
}

export class MockCipher implements PayloadCipher {
  encryptCalls = 0;
  decryptCalls = 0;
  /** Set to make the next encrypt or decrypt misbehave. */
  mode: "OK" | "THROW_ENCRYPT" | "THROW_DECRYPT" | "IDENTITY" | "PASSTHROUGH" | "WRAP" | "CORRUPT_DECRYPT" = "OK";

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    this.encryptCalls += 1;
    if (this.mode === "THROW_ENCRYPT") throw new Error("cipher unavailable");
    if (this.mode === "IDENTITY" || this.mode === "PASSTHROUGH") return Object.freeze({ keyId: "test-key-1", ciphertext: plaintext });
    if (this.mode === "WRAP") return Object.freeze({ keyId: "test-key-1", ciphertext: `enc:${plaintext}` });
    return Object.freeze({ keyId: "test-key-1", ciphertext: xor(Buffer.from(plaintext, "utf8")).toString("base64") });
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    this.decryptCalls += 1;
    if (this.mode === "THROW_DECRYPT") throw new Error("cipher unavailable");
    // PASSTHROUGH and WRAP are no-op "ciphers" that DO round-trip: only the OMS's "not in clear" check refuses them.
    if (this.mode === "PASSTHROUGH") return payload.ciphertext;
    if (this.mode === "WRAP") return payload.ciphertext.slice(4);
    const plaintext = xor(Buffer.from(payload.ciphertext, "base64")).toString("utf8");
    return this.mode === "CORRUPT_DECRYPT" ? `${plaintext} ` : plaintext;
  }
}
