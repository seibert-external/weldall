ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'chat_tool.requested', 'chat_tool.succeeded', 'chat_tool.failed',
      'machine_client.created', 'machine_client.updated', 'machine_client.deactivated',
      'machine_client.deleted', 'machine_key.registered', 'machine_key.revoked',
      'machine_access.replaced', 'machine_token.issued', 'machine_token.denied',
      'machine_token.failed', 'user_scopes.created', 'user_scopes.replaced',
      'user_scopes.deleted', 'resource_scopes.created', 'resource_scopes.replaced',
      'resource_scopes.deleted', 'cli_settings.updated', 'skill.created', 'skill.updated',
      'skill.deleted', 'group_provider.created', 'group_provider.updated',
      'group_provider.deleted', 'group_provider.tested', 'group_scopes.created',
      'group_scopes.replaced', 'group_scopes.deleted', 'iac.plan.generated',
      'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
      'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved'
    )
  );
