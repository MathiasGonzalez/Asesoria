/**
 * AuthService — passwordless OTP authentication and session management.
 *
 * ## Flow
 * 1. Client calls `requestOtp(email)` → a 6-digit code is stored in D1 and
 *    returned to the caller for delivery via email.
 * 2. Client calls `verifyOtp(email, code)` → validates the code and issues a
 *    session token (UUID). On **first login** a new tenant is provisioned
 *    automatically using the email domain as the tenant name, and the user is
 *    created with the `admin` role.
 * 3. Subsequent requests include the token as `Authorization: ******;
 *    `validateSession(token)` resolves it to a `SessionPayload`.
 * 4. `revokeSession(token)` permanently deletes the session row (logout).
 *
 * ## Security properties
 * - OTP codes are single-use (consumed immediately upon successful verification).
 * - Previous unused OTPs for the same email are invalidated before issuing a new one.
 * - OTPs expire after 10 minutes; sessions expire after 24 hours.
 * - Session tokens are cryptographically random UUIDs (128 bits of entropy).
 */

/** Minimal D1 binding required by AuthService. */
export interface AuthEnv {
  DB: D1Database;
}

/**
 * Decoded session payload returned by `validateSession`.
 * These values are injected into Hono request context variables
 * so every authenticated route handler can access them via `c.get(...)`.
 */
export interface SessionPayload {
  /** UUID of the authenticated user row. */
  userId: string;
  /** UUID of the tenant the user belongs to. */
  tenantId: string;
  /** Verified email address. */
  email: string;
  /** RBAC role: `'admin'` or `'viewer'`. */
  role: string;
}

/** OTP validity window in seconds (10 minutes). */
const OTP_EXPIRY_SECONDS = 600;
/** Session validity window in seconds (24 hours). */
const SESSION_EXPIRY_SECONDS = 86400;
/** Number of decimal digits in each generated OTP code. */
const OTP_DIGITS = 6;

function generateOtp(): string {
  const array = new Uint8Array(OTP_DIGITS);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => (b % 10).toString()).join("");
}

function generateId(): string {
  return crypto.randomUUID();
}

export class AuthService {
  constructor(private env: AuthEnv) {}

  /** Invalidates previous unused OTPs for email, creates a fresh one, and returns the code. */
  async requestOtp(email: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const code = generateOtp();
    const expiresAt = now + OTP_EXPIRY_SECONDS;

    await this.env.DB.prepare(
      "UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0"
    ).bind(email).run();

    await this.env.DB.prepare(
      "INSERT INTO otp_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(generateId(), email, code, expiresAt).run();

    return code;
  }

  /**
   * Verifies the OTP. On first-time login the user and a new tenant are created automatically.
   * Returns a session token and whether this is a new registration.
   */
  async verifyOtp(
    email: string,
    code: string
  ): Promise<{ sessionToken: string; isNewUser: boolean; userId: string }> {
    const now = Math.floor(Date.now() / 1000);

    const otpRow = await this.env.DB.prepare(
      `SELECT id FROM otp_codes
       WHERE email = ? AND code = ? AND used = 0 AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(email, code, now).first<{ id: string }>();

    if (!otpRow) {
      throw new Error("Código OTP inválido o expirado.");
    }

    // Consume the OTP immediately
    await this.env.DB.prepare(
      "UPDATE otp_codes SET used = 1 WHERE id = ?"
    ).bind(otpRow.id).run();

    // Find or auto-register user + tenant
    let user = await this.env.DB.prepare(
      "SELECT id, tenant_id FROM users WHERE email = ?"
    ).bind(email).first<{ id: string; tenant_id: string }>();

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const tenantId = generateId();
      const tenantName = email.split("@")[1] ?? email;

      await this.env.DB.prepare(
        "INSERT INTO tenants (id, name) VALUES (?, ?)"
      ).bind(tenantId, tenantName).run();

      const userId = generateId();
      await this.env.DB.prepare(
        "INSERT INTO users (id, email, tenant_id, role) VALUES (?, ?, ?, 'admin')"
      ).bind(userId, email, tenantId).run();

      user = { id: userId, tenant_id: tenantId };
    }

    // Create session
    const sessionToken = generateId();
    const expiresAt = now + SESSION_EXPIRY_SECONDS;

    await this.env.DB.prepare(
      "INSERT INTO sessions (id, user_id, tenant_id, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionToken, user.id, user.tenant_id, expiresAt).run();

    return { sessionToken, isNewUser, userId: user.id };
  }

  /** Validates a session token and returns its payload, or null if invalid/expired. */
  async validateSession(token: string): Promise<SessionPayload | null> {
    const now = Math.floor(Date.now() / 1000);

    const row = await this.env.DB.prepare(
      `SELECT s.tenant_id, u.id AS user_id, u.email, COALESCE(u.role, 'viewer') AS role
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > ?`
    ).bind(token, now).first<{ tenant_id: string; user_id: string; email: string; role: string }>();

    if (!row) return null;

    return { userId: row.user_id, tenantId: row.tenant_id, email: row.email, role: row.role };
  }

  /** Revokes (deletes) a session token. */
  async revokeSession(token: string): Promise<void> {
    await this.env.DB.prepare(
      "DELETE FROM sessions WHERE id = ?"
    ).bind(token).run();
  }

  /**
   * Records acceptance of a specific terms version for a user.
   * INSERT OR IGNORE ensures idempotency — re-logins with the same version are silently skipped.
   */
  async recordTermsConsent(userId: string, termsVersion: string, ip?: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO terms_consents (user_id, terms_version, ip)
       VALUES (?, ?, ?)`
    ).bind(userId, termsVersion, ip ?? null).run();
  }
}
