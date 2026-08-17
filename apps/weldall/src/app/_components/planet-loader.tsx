"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

gsap.registerPlugin(useGSAP);

export function PlanetLoader() {
  const rootRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const planet = "[data-loader-part='planet']";
        const shadow = "[data-loader-part='shadow']";
        const leftStar = "[data-loader-part='star-left']";
        const rightStar = "[data-loader-part='star-right']";

        gsap.set(`${planet}, ${shadow}, ${leftStar}, ${rightStar}`, {
          transformBox: "fill-box",
        });
        gsap.set(shadow, { transformOrigin: "center center" });
        gsap.set(`${leftStar}, ${rightStar}`, { transformOrigin: "center center" });

        gsap
          .timeline({ repeat: -1, repeatDelay: 1.12 })
          .to(planet, { y: -3, duration: 0.14, ease: "power2.out" }, 0)
          .to(shadow, { scaleX: 0.9, opacity: 0.68, duration: 0.14, ease: "power2.out" }, 0)
          .to(leftStar, { y: -1.5, scale: 1.035, duration: 0.12, ease: "power2.out" }, 0.05)
          .to(rightStar, { y: -1.1, scale: 1.04, duration: 0.12, ease: "power2.out" }, 0.09)
          .to(planet, { y: 0.45, duration: 0.2, ease: "power2.in" })
          .to(planet, { y: 0, duration: 0.16, ease: "power2.out" })
          .to(shadow, { scaleX: 1.015, opacity: 1, duration: 0.2, ease: "power2.in" }, 0.14)
          .to(shadow, { scaleX: 1, duration: 0.16, ease: "power2.out" }, 0.34)
          .to(
            `${leftStar}, ${rightStar}`,
            { y: 0, scale: 1, duration: 0.28, ease: "power2.inOut" },
            0.2,
          );
      });

      return () => media.revert();
    },
    { scope: rootRef },
  );

  return (
    <section
      ref={rootRef}
      className="flex min-h-[24rem] w-full flex-col items-center justify-center gap-4"
      aria-busy="true"
      aria-live="polite"
    >
      <svg
        className="h-auto w-[8.25rem] overflow-visible"
        viewBox="0 0 106 101"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <path
          data-loader-part="star-left"
          d="M14.0903 0L18.1161 9.62266L28.1806 10.9973L20.8 17.8707L22.8129 28.1806L14.0903 22.682L5.36774 28.1806L7.38065 17.8707L0 10.9973L10.0645 9.62266L14.0903 0Z"
          fill="#FFD166"
        />
        <path
          data-loader-part="star-right"
          d="M96.2839 23.4839L98.9677 29.7463L105.677 30.4421L100.981 35.3128L102.323 42.271L96.2839 38.7919L90.2452 42.271L91.5871 35.3128L86.8903 30.4421L93.6 29.7463L96.2839 23.4839Z"
          fill="#FFD166"
        />
        <ellipse
          data-loader-part="shadow"
          cx="22.3097"
          cy="3.52258"
          rx="22.3097"
          ry="3.52258"
          transform="matrix(1 0 0 -1 30.529 100.981)"
          fill="#C2C2C2"
        />
        <g data-loader-part="planet">
          <path
            d="M52.0479 85.3088C69.1204 85.3088 82.9604 71.4688 82.9604 54.3963C82.9604 37.3239 69.1204 23.4839 52.0479 23.4839C34.9755 23.4839 21.1355 37.3239 21.1355 54.3963C21.1355 71.4688 34.9755 85.3088 52.0479 85.3088Z"
            fill="#616AD1"
          />
          <path
            opacity="0.8"
            d="M28.1807 52.4791C42.829 61.968 60.407 60.3865 77.4968 49.3162"
            stroke="#CDD1F5"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            opacity="0.8"
            d="M37.5742 72.8239C47.3397 79.9406 59.0584 78.7544 70.4516 70.4517"
            stroke="#CDD1F5"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            opacity="0.8"
            d="M37.7202 35.2093C44.3282 36.3813 51.659 34.6016 58.3461 30.529"
            stroke="#CDD1F5"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      </svg>
      <p className="text-xs tracking-[0.025em] text-[var(--color-text-secondary)]">
        Pulling data from space
      </p>
    </section>
  );
}
