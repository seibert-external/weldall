"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@astryxdesign/core";
import type { ManagementDto } from "@/server/admin/service";

interface TooltipPosition {
  left: number;
  top: number;
  above: boolean;
}

export function ManagementBadge({ management }: { management: ManagementDto }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null);

  useEffect(() => {
    if (!tooltipPosition) return;
    const hideTooltip = () => setTooltipPosition(null);
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", hideTooltip, true);
    return () => {
      window.removeEventListener("resize", hideTooltip);
      window.removeEventListener("scroll", hideTooltip, true);
    };
  }, [tooltipPosition]);

  if (management.type === "manual") return null;

  const description = `Managed via ${management.workspaceName} (${management.address})`;
  const showTooltip = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const maximumWidth = Math.min(320, window.innerWidth - 16);
    setTooltipPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - maximumWidth - 8)),
      top: rect.top > 48 ? rect.top - 6 : rect.bottom + 6,
      above: rect.top > 48,
    });
  };

  return (
    <>
      <span
        ref={triggerRef}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
        aria-label={description}
        className="inline-flex"
        onBlur={() => setTooltipPosition(null)}
        onFocus={showTooltip}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTooltipPosition(null);
        }}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltipPosition(null)}
        tabIndex={0}
      >
        <Badge icon={<LockIcon />} label="IaC" variant="teal" />
      </span>
      {tooltipPosition
        ? createPortal(
            <span
              id={tooltipId}
              role="tooltip"
              className="pointer-events-none fixed z-[100] w-max max-w-80 rounded bg-neutral-900 px-2 py-1.5 text-xs text-white shadow-lg"
              style={{
                left: tooltipPosition.left,
                top: tooltipPosition.top,
                transform: tooltipPosition.above ? "translateY(-100%)" : undefined,
              }}
            >
              {description}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="12"
      viewBox="0 0 16 16"
      width="12"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" width="10" x="3" y="7" />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
