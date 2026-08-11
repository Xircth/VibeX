ALTER TABLE plugin_control_runtime_inventory
ADD COLUMN installer TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE plugin_control_runtime_inventory
ADD COLUMN probe_json TEXT NOT NULL DEFAULT '[]';
