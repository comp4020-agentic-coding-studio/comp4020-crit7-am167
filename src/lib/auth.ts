import { randomBytes } from "node:crypto";
import type { AstroCookies } from "astro";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "./db";
import { hashPassword, verifyPassword } from "./password";
import { type User, sessions, users } from "./schema";

// A pseudo sign-in, and honest about it: any well-formed ANU uni ID works,
// and the first time one is used it registers itself with whatever password
// was typed. There is no directory behind this and no password reset — it
// exists so the app can tell one person's bookings from another's, which is
// what a booking system actually needs from identity.
//
// What ISN'T pretend: the password is scrypt-hashed (src/lib/password.ts),
// the session token is 32 random bytes rather than a guessable user id, and
// the cookie is httpOnly so page scripts can't read it. Faking the policy is
// fine in a prototype; faking the mechanics teaches the wrong habit.

export const COOKIE = "session";
const SESSION_DAYS = 30;

/** ANU uni IDs are a `u` and seven digits. */
export const UNI_ID = /^u\d{7}$/;

/** Long enough for any password manager; short enough that nobody can make
 *  the server scrypt a megabyte of form body. */
export const MAX_PASSWORD = 256;

export type SignInResult =
  | { ok: true; user: User; token: string }
  | { ok: false; error: "bad-id" | "bad-password" | "long-password" };

/** The sign-in form supplies the `u` and asks only for the digits, but a
 *  pasted or autofilled `u1234567` means the same person. */
export function normaliseUniId(raw: string): string {
  const id = raw.trim().toLowerCase();
  return /^\d+$/.test(id) ? `u${id}` : id;
}

export function signIn(rawUniId: string, password: string): SignInResult {
  const uniId = normaliseUniId(rawUniId);
  if (!UNI_ID.test(uniId)) return { ok: false, error: "bad-id" };
  if (password.length < 4) return { ok: false, error: "bad-password" };
  if (password.length > MAX_PASSWORD) return { ok: false, error: "long-password" };

  const existing = db.select().from(users).where(eq(users.uniId, uniId)).get();
  if (existing) {
    if (!verifyPassword(password, existing.passwordHash)) {
      return { ok: false, error: "bad-password" };
    }
    return { ok: true, user: existing, token: createSession(existing.id) };
  }

  const created = db
    .insert(users)
    .values({
      uniId,
      displayName: uniId,
      passwordHash: hashPassword(password),
    })
    .returning()
    .get();
  return { ok: true, user: created, token: createSession(created.id) };
}

function createSession(userId: number): string {
  // opportunistic cleanup — there's no cron on a machine that stops when
  // nobody's using it, so expiry is swept on the way past
  db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.insert(sessions).values({ token, userId, expiresAt }).run();
  return token;
}

/** Whoever this request belongs to, or undefined for a visitor. */
export function currentUser(cookies: AstroCookies): User | undefined {
  const token = cookies.get(COOKIE)?.value;
  if (!token) return undefined;
  const row = db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date().toISOString())))
    .get();
  return row?.user;
}

export function setSessionCookie(cookies: AstroCookies, token: string): void {
  cookies.set(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: import.meta.env.PROD,
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function signOut(cookies: AstroCookies): void {
  const token = cookies.get(COOKIE)?.value;
  if (token) db.delete(sessions).where(eq(sessions.token, token)).run();
  cookies.delete(COOKIE, { path: "/" });
}

/** How to address someone: their name if they have one, else their id. */
export function nameOf(user: User): string {
  return user.displayName === user.uniId ? user.uniId : user.displayName;
}
