-- The v3 built-in Office package had no publisher, so the v4 compatibility
-- import assigned it the synthetic `legacy.local` identity. Adopt that exact
-- built-in package into its canonical v4 publisher before startup reconciliation.
INSERT OR IGNORE INTO plugin_packages_v4 (
    publisher, plugin_id, version, package_digest, source_kind, source_path,
    manifest_json, package_json, created_at
)
SELECT
    'dimo', plugin_id, version, package_digest, source_kind, source_path,
    manifest_json, json_set(package_json, '$.publisher', 'dimo'), created_at
FROM plugin_packages_v4
WHERE publisher = 'legacy.local'
  AND plugin_id = 'dimo.office'
  AND source_kind = 'builtin';

UPDATE plugin_installations_v4
SET publisher = 'dimo', updated_at = datetime('now','subsec')
WHERE plugin_id = 'dimo.office'
  AND publisher = 'legacy.local'
  AND EXISTS (
      SELECT 1
      FROM plugin_packages_v4
      WHERE publisher = 'dimo'
        AND plugin_id = 'dimo.office'
        AND package_digest = plugin_installations_v4.current_package_digest
  );

DELETE FROM plugin_packages_v4
WHERE publisher = 'legacy.local'
  AND plugin_id = 'dimo.office'
  AND source_kind = 'builtin'
  AND EXISTS (
      SELECT 1
      FROM plugin_installations_v4
      WHERE plugin_id = 'dimo.office'
        AND publisher = 'dimo'
  );
