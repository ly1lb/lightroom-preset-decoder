// Email + password accounts with scrypt hashing and opaque session tokens.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new AuthError(400, 'Neteisingas el. pašto adresas.');
  }
  validatePassword(password);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new AuthError(400, `Slaptažodis turi būti bent ${PASSWORD_MIN} simbolių.`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new AuthError(400, 'Slaptažodis per ilgas.');
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// A fixed hash used to keep login timing similar for unknown emails.
let dummyHash;

export class Auth {
  constructor(store, { allowRegistration = true } = {}) {
    this.store = store;
    this.allowRegistration = allowRegistration;
  }

  async findUserByEmail(email) {
    const users = await this.store.read('users.json', []);
    return users.find((u) => u.email === email) || null;
  }

  async findUserById(id) {
    const users = await this.store.read('users.json', []);
    return users.find((u) => u.id === id) || null;
  }

  async register(rawEmail, password, { force = false } = {}) {
    if (!this.allowRegistration && !force) {
      throw new AuthError(403, 'Registracija išjungta. Kreipkitės į administratorių.');
    }
    const email = normalizeEmail(rawEmail);
    validateCredentials(email, password);
    const passwordHash = await hashPassword(password);
    let user;
    await this.store.update('users.json', [], (users) => {
      if (users.some((u) => u.email === email)) {
        throw new AuthError(409, 'Paskyra su šiuo el. paštu jau egzistuoja.');
      }
      user = { id: crypto.randomUUID(), email, passwordHash, createdAt: new Date().toISOString() };
      users.push(user);
    });
    return publicUser(user);
  }

  async login(rawEmail, password) {
    const email = normalizeEmail(rawEmail);
    const user = await this.findUserByEmail(email);
    if (!user) {
      dummyHash ||= await hashPassword('dummy-password-for-timing');
      await verifyPassword(String(password ?? ''), dummyHash);
      throw new AuthError(401, 'Neteisingas el. paštas arba slaptažodis.');
    }
    const ok = await verifyPassword(String(password ?? ''), user.passwordHash);
    if (!ok) throw new AuthError(401, 'Neteisingas el. paštas arba slaptažodis.');
    return { user: publicUser(user), token: await this.createSession(user.id) };
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = await this.findUserById(userId);
    if (!user || !(await verifyPassword(String(currentPassword ?? ''), user.passwordHash))) {
      throw new AuthError(401, 'Dabartinis slaptažodis neteisingas.');
    }
    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    await this.store.update('users.json', [], (users) => {
      const u = users.find((x) => x.id === userId);
      if (u) u.passwordHash = passwordHash;
    });
    // Sign out every other session.
    await this.store.update('sessions.json', {}, (sessions) => {
      for (const [key, s] of Object.entries(sessions)) if (s.userId === userId) delete sessions[key];
    });
    return this.createSession(userId);
  }

  async createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.store.update('sessions.json', {}, (sessions) => {
      for (const [key, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[key];
      sessions[sha256(token)] = { userId, created: now, expires: now + SESSION_TTL_MS };
    });
    return token;
  }

  async userForToken(token) {
    if (!token) return null;
    const sessions = await this.store.read('sessions.json', {});
    const session = sessions[sha256(token)];
    if (!session || session.expires < Date.now()) return null;
    const user = await this.findUserById(session.userId);
    return user ? publicUser(user) : null;
  }

  async logout(token) {
    if (!token) return;
    await this.store.update('sessions.json', {}, (sessions) => {
      delete sessions[sha256(token)];
    });
  }
}

export const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000;

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

// Simple fixed-window limiter for failed login attempts.
export class RateLimiter {
  constructor({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  isBlocked(key) {
    const entry = this.hits.get(key);
    if (!entry) return false;
    if (Date.now() - entry.start > this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return entry.count >= this.limit;
  }

  fail(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) this.hits.set(key, { start: now, count: 1 });
    else entry.count += 1;
  }

  reset(key) {
    this.hits.delete(key);
  }
}
