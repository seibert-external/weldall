import type { CSSProperties, ReactNode } from "react";

type SkillNoiseBadgeTone = "tag" | "resource" | "granted" | "missing";

const toneColors: Record<SkillNoiseBadgeTone, { from: string; to: string }> = {
  tag: { from: "#555bd6", to: "#7773e5" },
  resource: { from: "rgb(151, 132, 48)", to: "rgb(181, 111, 45)" },
  granted: { from: "rgb(28, 143, 111)", to: "rgb(82, 153, 78)" },
  missing: { from: "rgb(179, 72, 65)", to: "rgb(204, 76, 84)" },
};

export function SkillNoiseBadge({
  children,
  tone = "tag",
}: {
  children: ReactNode;
  tone?: SkillNoiseBadgeTone;
}) {
  const colors = toneColors[tone];
  const style = {
    "--skill-noise-from": colors.from,
    "--skill-noise-to": colors.to,
  } as CSSProperties;

  return (
    <span className="skill-noise-surface" style={style}>
      <span>{children}</span>
    </span>
  );
}
