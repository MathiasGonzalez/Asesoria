/**
 * FeatureFlagsService — tenant-aware feature flag resolution backed by D1.
 *
 * ## How flags work
 * Feature flags are stored in the `feature_flags` table with two levels:
 * - **Global** (`tenant_id IS NULL`): default value for all tenants.
 * - **Tenant-specific** (`tenant_id = <id>`): overrides the global value for
 *   that tenant only.
 *
 * `getFlags` merges both levels, with tenant-specific rows taking precedence.
 *
 * ## Built-in flags
 * | Flag name | Default | Description |
 * |-----------|---------|-------------|
 * | `ai_search_enabled` | `true` | Enables the AI-powered normative search endpoint |
 * | `document_ingestion_enabled` | `true` | Enables the `/api/ingest` document pipeline |
 * | `hybrid_search_enabled` | `true` | Adds FTS5 lexical results to the semantic search |
 * | `otp_auth_enabled` | `true` | Requires OTP email authentication |
 * | `portal_automation_enabled` | `false` | Enables DGI/BPS Browser Rendering automation |
 */
export interface FeatureFlagsEnv {
  DB: D1Database;
}

export class FeatureFlagsService {
  constructor(private env: FeatureFlagsEnv) {}

  /**
   * Returns a map of flag-name → enabled for the given tenant.
   * Global flags (tenant_id IS NULL) act as defaults; tenant-specific rows override them.
   */
  async getFlags(tenantId: string): Promise<Record<string, boolean>> {
    const rows = await this.env.DB.prepare(
      `SELECT name, enabled, tenant_id FROM feature_flags
       WHERE tenant_id IS NULL OR tenant_id = ?
       ORDER BY tenant_id IS NOT NULL`  // NULLs (globals) first, then tenant overrides
    ).bind(tenantId).all<{ name: string; enabled: number; tenant_id: string | null }>();

    const flags: Record<string, boolean> = {};
    for (const row of rows.results) {
      flags[row.name] = row.enabled === 1;
    }
    return flags;
  }

  /** Upserts a feature flag for a specific tenant (or globally when tenantId is null). */
  async setFlag(
    tenantId: string | null,
    name: string,
    enabled: boolean
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO feature_flags (tenant_id, name, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, name) DO UPDATE
       SET enabled = excluded.enabled,
           updated_at = strftime('%s', 'now')`
    ).bind(tenantId, name, enabled ? 1 : 0).run();
  }
}
