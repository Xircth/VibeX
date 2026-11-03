ALTER TABLE server_device_credentials
    ADD COLUMN client_kind TEXT;

ALTER TABLE server_device_credentials
    ADD COLUMN last_ip TEXT;

ALTER TABLE server_device_credentials
    ADD COLUMN last_connected_at_unix INTEGER;

UPDATE server_access_tokens
SET scopes_json = '["conversation.read","conversation.write","conversation.attach","conversation.permission","conversation.question","conversation.cancel","conversation.steer","application.call","plugin.read","plugin.write","plugin.surface","artifact.read","artifact.preview","automation.read","automation.write","delegation.read","delegation.cancel","workflow.read","workflow.write","workflow.run","workflow.approve","workflow.internal","device.pair","device.revoke","notification.summary","offline.read","workspace.terminal"]'
WHERE revoked_at IS NULL;
