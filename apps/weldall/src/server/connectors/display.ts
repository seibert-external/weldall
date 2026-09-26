/** Provider-supplied presentation data; never used to authorize requests. */
export interface ScopeDescriptor {
  id: string;
  label: string;
  description: string;
  group: string;
  required: boolean;
}

/** Shared scope-picker contract. Providers own scope IDs, labels and selection validation. */
export interface ConnectorSetupDisplay {
  scopes: ScopeDescriptor[];
  defaultScopes: string[];
  selection?: { scopes: string[] };
}

/** Credential-free permission metadata for shared admin and CLI views. */
export interface ConnectionDisplay {
  selectedScopes: string[];
  grantedScopes: string[];
  scopeLabels: Record<string, string>;
}
