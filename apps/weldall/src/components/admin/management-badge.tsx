import { Badge } from "@astryxdesign/core";
import type { ManagementDto } from "@/server/admin/service";

export function ManagementBadge({ management }: { management: ManagementDto }) {
  if (management.type === "manual") return null;
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`${management.workspaceName} · ${management.address}`}
    >
      <Badge label="IaC" variant="purple" />
      <span className="text-xs text-neutral-500">
        {management.workspaceName} · <code>{management.address}</code>
      </span>
    </span>
  );
}
