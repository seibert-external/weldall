import type { CSSProperties, ReactNode } from "react";

type SkillNoiseBadgeTone = "tag" | "resource" | "granted" | "missing";

const toneColors: Record<SkillNoiseBadgeTone, { from: string; to: string }> = {
  tag: { from: "#5730cc", to: "#5730cc" },
  resource: { from: "rgb(140, 95, 30)", to: "rgb(140, 95, 30)" },
  granted: { from: "rgb(9, 133, 119)", to: "rgb(9, 133, 119)" },
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
    <span className="skill-noise-surface" data-tone={tone} style={style}>
      <span>{children}</span>
    </span>
  );
}
