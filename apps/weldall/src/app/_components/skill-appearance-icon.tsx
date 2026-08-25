"use client";

import { createElement, type SVGProps } from "react";
import {
  resolveSkillAppearance,
  type SkillAppearance,
  type SkillAppearanceIconNode,
} from "./skill-appearance";

export function SkillAppearanceIcon({
  seed,
  appearance,
  iconNode,
  ...props
}: SVGProps<SVGSVGElement> & {
  seed: string;
  appearance?: Readonly<SkillAppearance> | undefined;
  iconNode?: SkillAppearanceIconNode | undefined;
}) {
  const resolvedNode = iconNode ?? resolveSkillAppearance(seed, appearance).fallbackIconNode;
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {resolvedNode.map(([element, attributes]) =>
        createElement(element, { ...attributes, key: attributes.key }),
      )}
    </svg>
  );
}
