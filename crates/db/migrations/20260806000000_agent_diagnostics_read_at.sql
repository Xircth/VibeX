-- 操作诊断支持"已读"状态:read_at 非空表示已读。
ALTER TABLE agent_diagnostic ADD COLUMN read_at TEXT;
