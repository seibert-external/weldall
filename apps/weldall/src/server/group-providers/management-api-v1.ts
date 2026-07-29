import { z } from "zod";
import type {
  GroupProviderAdapter,
  GroupProviderGroup,
  GroupProviderUser,
  GroupProviderUserSummary,
} from "./types";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_GROUPS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

const providerGroupSchema = z.object({
  ou: z.string().trim().min(1).max(191),
  cn: z.string().trim().max(191).optional(),
  description: z.string().trim().max(2_000).optional().nullable(),
});
const providerUserSummarySchema = z.object({
  username: z.string().trim().min(1).max(191),
  email: z.string().email().max(320),
  is_active: z.boolean(),
});
const providerUserDetailSchema = providerUserSummarySchema.extend({
  groups: z.array(z.string().trim().min(1).max(191)).max(MAX_GROUPS),
});
const groupListSchema = z.array(providerGroupSchema).max(MAX_GROUPS);
const userListSchema = z.array(providerUserSummarySchema).max(2);

export class GroupProviderRequestError extends Error {
  constructor(readonly category: string) {
    super(`Group provider request failed (${category}).`);
    this.name = "GroupProviderRequestError";
  }
}

export class ManagementApiV1Adapter implements GroupProviderAdapter {
  constructor(
    private readonly config: { baseUrl: string; token: string },
    private readonly request: typeof fetch = fetch,
  ) {}

  async searchGroups(query: string, limit: number): Promise<GroupProviderGroup[]> {
    const groups = await this.listGroups();
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return groups
      .filter((group) => {
        const candidate =
          `${group.id} ${group.name} ${group.description ?? ""}`.toLocaleLowerCase();
        return terms.every((term) => candidate.includes(term));
      })
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }

  async getGroups(groupIds: string[]): Promise<GroupProviderGroup[]> {
    if (groupIds.length > 100) throw new GroupProviderRequestError("request_limit");
    const wanted = new Set(groupIds);
    const groups = await this.listGroups();
    const byId = new Map(groups.map((group) => [group.id, group]));
    return [...wanted].flatMap((id) => {
      const group = byId.get(id);
      return group ? [group] : [];
    });
  }

  async getGroup(groupId: string): Promise<GroupProviderGroup> {
    const parsed = providerGroupSchema.parse(
      await this.getJson(`/api/management/groups/${encodeURIComponent(groupId)}/`),
    );
    if (parsed.ou !== groupId) throw new GroupProviderRequestError("group_identity_mismatch");
    return mapGroup(parsed);
  }

  async testConnection(): Promise<{ groupCount: number }> {
    return { groupCount: (await this.listGroups()).length };
  }

  async findUserByEmail(email: string): Promise<GroupProviderUserSummary | null> {
    const normalizedEmail = normalizeEmail(email);
    const result = userListSchema.parse(
      await this.getJson(`/api/management/users/?mail=${encodeURIComponent(normalizedEmail)}`),
    );
    if (result.length === 0) return null;
    if (result.length !== 1) throw new GroupProviderRequestError("ambiguous_user");
    const user = mapUser(result[0]!);
    if (user.email !== normalizedEmail) {
      throw new GroupProviderRequestError("user_email_mismatch");
    }
    return user;
  }

  async getUser(userId: string): Promise<GroupProviderUser> {
    const user = providerUserDetailSchema.parse(
      await this.getJson(`/api/management/users/${encodeURIComponent(userId)}/`),
    );
    return { ...mapUser(user), groupIds: [...new Set(user.groups)] };
  }

  private async listGroups(): Promise<GroupProviderGroup[]> {
    return groupListSchema.parse(await this.getJson("/api/management/groups/")).map(mapGroup);
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request(`${this.config.baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Token ${this.config.token}`, Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new GroupProviderRequestError("redirect");
      }
      if (!response.ok) throw new GroupProviderRequestError(`http_${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        throw new GroupProviderRequestError("content_type");
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_RESPONSE_BYTES) throw new GroupProviderRequestError("body_limit");
      const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new GroupProviderRequestError("invalid_json");
      }
    } catch (error) {
      if (error instanceof GroupProviderRequestError || error instanceof z.ZodError) throw error;
      throw new GroupProviderRequestError(error instanceof DOMException ? "timeout" : "transport");
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GroupProviderRequestError("body_limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mapGroup(group: z.infer<typeof providerGroupSchema>): GroupProviderGroup {
  return {
    id: group.ou,
    name: group.cn || group.ou,
    ...(group.description ? { description: group.description } : {}),
  };
}

function mapUser(user: z.infer<typeof providerUserSummarySchema>): GroupProviderUserSummary {
  return { id: user.username, email: normalizeEmail(user.email), active: user.is_active };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
