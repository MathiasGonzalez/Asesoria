-- Add role-based access control to users.
-- 'admin'  → can ingest and delete documents.
-- 'viewer' → read-only (search + history).
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';

-- Promote the earliest-registered user of each tenant to admin.
-- For fresh installs this sets every existing user to admin since each user
-- is currently the sole member of their auto-created tenant.
UPDATE users
SET role = 'admin'
WHERE id IN (
  SELECT u.id
  FROM users u
  INNER JOIN (
    SELECT tenant_id, MIN(created_at) AS first_at
    FROM users
    GROUP BY tenant_id
  ) first_per_tenant
    ON u.tenant_id = first_per_tenant.tenant_id
   AND u.created_at = first_per_tenant.first_at
);
