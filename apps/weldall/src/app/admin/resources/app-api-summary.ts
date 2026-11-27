import type { AppApiRefusal } from "@/server/apps/discovery";
import type { AppApiStatus } from "@/server/apps/service";

const refusals: Record<AppApiRefusal, string> = {
  malformed: "it is not an object with an endpoint and a scope",
  endpoint_invalid:
    "the endpoint is not an https URL on the resource's origin without query or fragment ending in /apps",
  scope_not_of_resource: "the scope is not one of this resource's scopes",
  scope_reserved: "the scope is one of Weldall's own permissions",
  admin_scope_not_of_resource: "the admin scope is not one of this resource's scopes",
  admin_scope_reserved: "the admin scope is one of Weldall's own permissions",
  admin_scope_same_as_scope: "the admin scope is the same as the scope",
  git_invalid: "the Git route is not exactly <resource origin>/git/",
  git_credentials_invalid:
    "the Git credentials endpoint is not an https URL on the resource's origin without query or fragment",
};

/**
 * How the resource page shows the apps API a resource names (`weldall_apps_api`): what clients are
 * told of it as a registry, or why they are told nothing.
 */
export function appApiSummary(status: AppApiStatus): {
  tone: "success" | "warning" | "error" | "info";
  title: string;
  detail: string;
} {
  const checked = `Last read: ${status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "never"}`;
  const api = status.api
    ? [
        `Endpoint: ${status.api.endpoint}`,
        `Scope: ${status.api.scope}`,
        `Admin scope: ${status.api.adminScope ?? "none"}`,
        `Git: ${status.api.git ?? "none"}`,
        `Git credentials: ${status.api.gitCredentials ?? "none"}`,
      ].join(" · ")
    : null;
  switch (status.state) {
    case "accepted":
      return {
        tone: "success",
        title: "App registry: listed for clients",
        detail: `${api} · ${checked}`,
      };
    case "expired":
      return {
        tone: "error",
        title: "App registry: not listed, the metadata was last read more than a day ago",
        detail: `${api} · ${checked}`,
      };
    case "refused":
      return {
        tone: "error",
        title: "App registry: refused",
        detail: `Clients are not told of it: ${
          status.refusal ? refusals[status.refusal] : "it failed Weldall's checks"
        } · ${checked}`,
      };
    case "absent":
      return {
        tone: "info",
        title: "App registry: none",
        detail: `The resource names no apps API (weldall_apps_api) · ${checked}`,
      };
    case "pending":
      return {
        tone: "info",
        title: "App registry: pending",
        detail: "The metadata has not been read with app discovery on yet",
      };
  }
}
