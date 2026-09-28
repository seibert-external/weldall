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
  selection?: { scopes: string[] } & Record<string, unknown>;
  choices?: {
    key: string;
    label: string;
    description: string;
    options: { value: string; label: string }[];
  }[];
}

/** Provider-owned guidance, never an authorization claim or executable shell script. */
export interface ConnectionUsage {
  instructions: string[];
  examples: { label: string; method: string; url: string }[];
}

/** Credential-free permission metadata for shared admin and CLI views. */
export interface ConnectionDisplay {
  selectedScopes: string[];
  grantedScopes: string[];
  scopeLabels: Record<string, string>;
  details?: { label: string; value: string }[];
  usage?: ConnectionUsage;
}
