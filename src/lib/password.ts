import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// The sign-in is a pretend one — any well-formed uni ID registers itself on
// first use — but passwords are still salted and hashed with scrypt rather
// than stored in the clear. A prototype that fakes authentication is fine;
// one that teaches you to keep plaintext passwords is not. scrypt comes with
// Node, so this costs no dependency and no native build.

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  return timingSafeEqual(expected, actual);
}
