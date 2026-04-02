import assert from "node:assert/strict";
import test from "node:test";

import { decryptTenantSecret, encryptTenantSecret } from "../src/tenantSecrets";

test("encrypts and decrypts tenant secrets with the configured master secret", () => {
  const encrypted = encryptTenantSecret("super-secret-token", "master-secret");

  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.ok(encrypted.salt.length > 0);
  assert.ok(encrypted.iv.length > 0);
  assert.ok(encrypted.tag.length > 0);
  assert.ok(encrypted.ciphertext.length > 0);
  assert.equal(decryptTenantSecret(encrypted, "master-secret"), "super-secret-token");
});
