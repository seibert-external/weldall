"use client";

import { useRef, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

gsap.registerPlugin(useGSAP);

export function AppearanceSequence({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;

      const elements = gsap.utils.toArray<HTMLElement>("[data-appear]", root);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        gsap.set(elements, { autoAlpha: 1, y: 0 });
        return;
      }

      gsap.fromTo(
        elements,
        { autoAlpha: 0, y: 12 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.45,
          ease: "power2.out",
          stagger: 0.09,
        },
      );
    },
    { scope: rootRef },
  );

  return (
    <div ref={rootRef} className="appearance-sequence">
      {children}
    </div>
  );
}
