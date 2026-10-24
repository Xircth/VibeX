-- A delivery to a sleeping member that exceeded the per-turn wake cap is
-- held (receipt shown as 'limit_reached') under the originating turn key and
-- released once that turn ends (or on the next sweep for message keys).
ALTER TABLE collaboration_space_deliveries ADD COLUMN wake_deferred_turn_key TEXT;
ALTER TABLE collaboration_space_deliveries ADD COLUMN wake_deferred_at TEXT;
