#!/usr/bin/env node
// Generate a scrypt password hash for the self-host auth wall.
//
// Usage:
//   node ops/selfhost-auth/hash-password.mjs 'my secret password'
//   node ops/selfhost-auth/hash-password.mjs            # prompts (hidden input)
//
// Copy the printed value into PASEO_AUTH_PASSWORD_HASH. The plaintext password
// is never stored anywhere — only this hash. See docs/selfhost-auth.md.

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const KEYLEN = 64;

function hash(plain) {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function promptHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Mute the echo so the typed password is not shown on screen.
  const output = rl.output;
  const originalWrite = output.write.bind(output);
  let muted = false;
  output.write = (chunk, ...rest) => (muted ? true : originalWrite(chunk, ...rest));
  process.stdout.write(question);
  muted = true;
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      muted = false;
      output.write = originalWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const fromArg = process.argv[2];
const plain = fromArg ?? (await promptHidden("Mot de passe : "));
if (!plain) {
  console.error("Mot de passe vide, abandon.");
  process.exit(1);
}
console.log(hash(plain));
