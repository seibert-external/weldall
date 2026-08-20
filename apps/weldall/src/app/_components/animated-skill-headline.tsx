"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef } from "react";

gsap.registerPlugin(useGSAP);

export function AnimatedSkillHeadline({ title }: { title: string }) {
  const headlineRef = useRef<HTMLHeadingElement>(null);

  useGSAP(
    () => {
      const headline = headlineRef.current;
      if (!headline) return;
      const characters = gsap.utils.toArray<HTMLElement>(".skill-headline-char", headline);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        gsap.set(characters, { opacity: 1, y: 0, filter: "blur(0px)" });
        return;
      }

      gsap.fromTo(
        characters,
        { opacity: 0, y: 10, filter: "blur(4px)" },
        {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.1,
          ease: "power2.out",
          stagger: { each: 0.006, from: "random" },
          overwrite: "auto",
        },
      );
    },
    { dependencies: [title], scope: headlineRef },
  );

  return (
    <h1 ref={headlineRef} aria-label={title}>
      {Array.from(title).map((character, index) => (
        <span
          aria-hidden="true"
          className="skill-headline-char"
          key={`${character}:${index}`}
        >
          {character === " " ? "\u00a0" : character}
        </span>
      ))}
    </h1>
  );
}
