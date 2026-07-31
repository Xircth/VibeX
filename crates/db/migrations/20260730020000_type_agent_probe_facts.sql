ALTER TABLE agent_probe
    ADD COLUMN runtime_available INTEGER NOT NULL DEFAULT 0
        CHECK (runtime_available IN (0, 1));

ALTER TABLE agent_probe
    ADD COLUMN acp_handshake INTEGER NOT NULL DEFAULT 0
        CHECK (acp_handshake IN (0, 1));

ALTER TABLE agent_probe
    ADD COLUMN authentication_required INTEGER NOT NULL DEFAULT 0
        CHECK (authentication_required IN (0, 1));

-- One-way compatibility import for databases written before the typed
-- columns existed. Product code no longer reads business facts from
-- detail_json after this migration.
UPDATE agent_probe
SET runtime_available = COALESCE(
        CAST(json_extract(detail_json, '$.runtime_available') AS INTEGER),
        0
    ),
    acp_handshake = COALESCE(
        CAST(json_extract(detail_json, '$.acp_handshake') AS INTEGER),
        0
    ),
    authentication_required = COALESCE(
        CAST(json_extract(detail_json, '$.authentication_required') AS INTEGER),
        0
    );
