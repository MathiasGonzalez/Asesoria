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
