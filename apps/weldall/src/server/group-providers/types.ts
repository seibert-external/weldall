export type GroupProviderAdapterType = "management-api-v1";

export interface GroupProviderGroup {
  id: string;
  name: string;
  description?: string;
}

export interface GroupProviderUserSummary {
  id: string;
  email: string;
  active: boolean;
}

export interface GroupProviderUser extends GroupProviderUserSummary {
  groupIds: string[];
}

export interface GroupProviderAdapter {
  searchGroups(query: string, limit: number): Promise<GroupProviderGroup[]>;
  getGroups(groupIds: string[]): Promise<GroupProviderGroup[]>;
  getGroup(groupId: string): Promise<GroupProviderGroup>;
  testConnection(): Promise<{ groupCount: number }>;
  findUserByEmail(email: string): Promise<GroupProviderUserSummary | null>;
  getUser(userId: string): Promise<GroupProviderUser>;
}

export interface GroupProviderAdapterConfig {
  adapterType: GroupProviderAdapterType;
  baseUrl: string;
  token: string;
}
