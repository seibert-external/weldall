"use client";

import { useEffect, useRef, useState } from "react";

const ASCII_RAMP = Array.from(".,:;irsXA253hMHGS#9B&@");
const FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SVG_URL = "/assets/glyph-hero.svg";
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

type DitherMode = "none" | "ordered" | "noise";

interface HeroGlyphConfig {
  density: number;
  contrast: number;
  gamma: number;
  levels: number;
  dither: DitherMode;
  glyphSet: string;
  glyphSize: number;
  variation: number;
  foreground: string;
  animationDensity: number;
  activity: number;
  speed: number;
}

const DEFAULT_HERO_GLYPH_CONFIG: HeroGlyphConfig = {
  density: 100,
  contrast: 200,
  gamma: 100,
  levels: 24,
  dither: "none",
  glyphSet: ASCII_RAMP.join(""),
  glyphSize: 100,
  variation: 25,
  foreground: "#737373",
  animationDensity: 50,
  activity: 25,
  speed: 70,
};

interface GlyphMark {
  x: number;
  y: number;
  glyph: string;
  color: string;
  opacity: number;
  size: number;
  weight: number;
}

interface SourceGlyphMark extends Omit<GlyphMark, "color"> {
  density: number;
}

interface GlyphTransition {
  mark: GlyphMark;
  from: string;
  to: string;
  delay: number;
  duration: number;
}

interface ReadingZone {
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const smoothstep = (value: number) => {
  const clamped = clamp(value);
  return clamped * clamped * (3 - 2 * clamped);
};

const hash = (x: number, y: number) => {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
};

const nextGlyph = (
  current: string,
  distanceScale: number,
  glyphs: string[],
) => {
  const ramp = glyphs.length > 1 ? glyphs : ASCII_RAMP;
  const currentIndex = ramp.indexOf(current);
  const direction = Math.random() < 0.5 ? -1 : 1;
  const distance = Math.max(
    1,
    Math.round((2 + Math.floor(Math.random() * 4)) * distanceScale),
  );
  const fallbackIndex = Math.floor(Math.random() * ramp.length);
  const nextIndex =
    currentIndex < 0
      ? fallbackIndex
      : Math.min(
          ramp.length - 1,
          Math.max(0, currentIndex + direction * distance),
        );

  const next = ramp[nextIndex] ?? ".";
  if (next !== current) return next;
  return ramp[currentIndex === 0 ? 1 : currentIndex - 1] ?? next;
};

const LoginGlyphCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );

    const controller = new AbortController();
    let disposed = false;
    let initialized = false;
    let isVisible = true;
    let timer: number | undefined;
    let animationFrame: number | undefined;
    let redrawFrame: number | undefined;
    let activeTransitions: GlyphTransition[] = [];
    let sourceMarks: SourceGlyphMark[] = [];
    let marks: GlyphMark[] = [];
    let candidates: GlyphMark[] = [];
    const currentConfig = { ...DEFAULT_HERO_GLYPH_CONFIG };
    let gridWidth = 6;
    let gridHeight = 6.36;
    let sourceWidth = 1200;
    let sourceHeight = 675;
    let readingZone: ReadingZone | undefined;
    let readingZoneColor = "#ffffff";

    const context = canvas.getContext("2d");
    if (!context) return;

    const rebuildMarks = () => {
      const glyphs = Array.from(currentConfig.glyphSet).filter(
        (character) => character.trim().length > 0,
      );
      const characters = glyphs.length > 1 ? glyphs : ASCII_RAMP;
      const steps = Math.max(2, currentConfig.levels - 1);
      const usesOriginalAppearance =
        currentConfig.density === 100 &&
        currentConfig.contrast === 100 &&
        currentConfig.gamma === 100 &&
        currentConfig.levels === 24 &&
        currentConfig.dither === "none" &&
        currentConfig.glyphSet === ASCII_RAMP.join("") &&
        currentConfig.glyphSize === 100 &&
        currentConfig.variation === 0;

      marks = sourceMarks.map((sourceMark) => {
        if (usesOriginalAppearance) {
          return {
            ...sourceMark,
            color: currentConfig.foreground,
          };
        }

        const column = Math.max(0, Math.round(sourceMark.x / gridWidth - 0.5));
        const row = Math.max(0, Math.round(sourceMark.y / gridHeight - 0.5));
        let density = clamp(
          (sourceMark.density - 0.5) * (currentConfig.contrast / 100) + 0.5,
        );
        density = Math.pow(density, currentConfig.gamma / 100);
        if (currentConfig.dither === "ordered") {
          const threshold = BAYER_4[row % 4]?.[column % 4] ?? 0;
          density += (((threshold + 0.5) / 16 - 0.5) / steps) * 1.2;
        }
        if (currentConfig.dither === "noise") {
          density += ((hash(column, row) - 0.5) / steps) * 1.65;
        }
        density = Math.round(clamp(density) * steps) / steps;
        density = clamp(density * (currentConfig.density / 100));
        density = clamp(
          density +
            (hash(column + 41, row + 79) - 0.5) *
              (currentConfig.variation / 100),
        );
        const glyphIndex = Math.min(
          characters.length - 1,
          Math.max(0, Math.floor(density * characters.length)),
        );

        return {
          x: sourceMark.x,
          y: sourceMark.y,
          glyph: characters[glyphIndex] || characters[0] || ".",
          color: currentConfig.foreground,
          opacity: density < 0.035 ? 0 : 0.28 + density * 0.72,
          size:
            gridWidth *
            (currentConfig.glyphSize / 100) *
            (0.58 + density * 0.42),
          weight: density > 0.76 ? 700 : 500,
        };
      });

      candidates = marks.filter(
        (mark) =>
          mark.opacity > 0 &&
          hash(mark.x + 113, mark.y + 197) <=
            currentConfig.animationDensity / 100,
      );
    };

    const canAnimate = () =>
      initialized &&
      isVisible &&
      !document.hidden &&
      !motionPreference.matches &&
      !disposed;

    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const clearFrame = () => {
      if (animationFrame === undefined) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    };

    const clearCell = (mark: GlyphMark) => {
      context.clearRect(
        mark.x - gridWidth / 2,
        mark.y - gridHeight / 2,
        gridWidth,
        gridHeight,
      );
    };

    const drawGlyph = (mark: GlyphMark, glyph: string, alpha = 1) => {
      const isInReadingZone =
        readingZone &&
        mark.x >= readingZone.x &&
        mark.x <= readingZone.x + readingZone.width &&
        mark.y >= readingZone.y &&
        mark.y <= readingZone.y + readingZone.height;

      context.globalAlpha = mark.opacity * alpha;
      context.fillStyle = isInReadingZone ? readingZoneColor : mark.color;
      context.font = `${mark.weight} ${mark.size}px ${FONT_FAMILY}`;
      context.fillText(glyph, mark.x, mark.y);
      context.globalAlpha = 1;
    };

    const finishTransitions = () => {
      clearFrame();
      for (const transition of activeTransitions) {
        clearCell(transition.mark);
        drawGlyph(transition.mark, transition.to);
        transition.mark.glyph = transition.to;
      }
      activeTransitions = [];
    };

    const updateReadingZone = () => {
      const description = document.getElementById("login-description");
      const hero = document.getElementById("login-hero");
      if (!description || !hero) {
        readingZone = undefined;
        return;
      }

      const canvasRect = canvas.getBoundingClientRect();
      const descriptionRect = description.getBoundingClientRect();
      const coverScale = Math.max(
        canvasRect.width / sourceWidth,
        canvasRect.height / sourceHeight,
      );
      const renderedWidth = sourceWidth * coverScale;
      const offsetX = canvasRect.width - renderedWidth;
      const horizontalPadding = 34;
      const verticalPadding = 24;

      readingZone = {
        x:
          (descriptionRect.left -
            canvasRect.left -
            offsetX -
            horizontalPadding) /
          coverScale,
        y:
          (descriptionRect.top - canvasRect.top - verticalPadding) / coverScale,
        width: (descriptionRect.width + horizontalPadding * 2) / coverScale,
        height: (descriptionRect.height + verticalPadding * 2) / coverScale,
        feather: 22 / coverScale,
      };

      context.fillStyle = "#ffffff";
      context.fillStyle = getComputedStyle(hero).backgroundColor;
      readingZoneColor = String(context.fillStyle);
    };

    const renderScene = () => {
      if (marks.length === 0) return;

      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const targetWidth = Math.round(sourceWidth * pixelRatio);
      const targetHeight = Math.round(sourceHeight * pixelRatio);
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.clearRect(0, 0, sourceWidth, sourceHeight);
      updateReadingZone();

      for (const mark of marks) {
        if (mark.opacity > 0) drawGlyph(mark, mark.glyph);
      }

      if (readingZone) {
        const inset = readingZone.feather / 2;
        context.save();
        context.globalCompositeOperation = "source-atop";
        context.filter = `blur(${readingZone.feather}px)`;
        context.fillStyle = readingZoneColor;
        context.fillRect(
          readingZone.x + inset,
          readingZone.y + inset,
          Math.max(0, readingZone.width - inset * 2),
          Math.max(0, readingZone.height - inset * 2),
        );
        context.restore();
      }
    };

    const queueRedraw = () => {
      if (!initialized || disposed) return;
      if (redrawFrame !== undefined) {
        window.cancelAnimationFrame(redrawFrame);
      }
      redrawFrame = window.requestAnimationFrame(() => {
        redrawFrame = undefined;
        finishTransitions();
        renderScene();
        scheduleNext();
      });
    };

    const scheduleNext = (initial = false) => {
      clearTimer();
      if (!canAnimate()) return;

      const speedFactor = 100 / currentConfig.speed;
      const delay =
        (initial ? 150 + Math.random() * 150 : 400 + Math.random() * 600) *
        speedFactor;
      timer = window.setTimeout(startTransitions, delay);
    };

    const startTransitions = () => {
      timer = undefined;
      if (!canAnimate() || candidates.length === 0) return;

      const count = Math.min(
        candidates.length,
        Math.max(
          1,
          Math.round(
            candidates.length *
              (currentConfig.activity / 100) *
              (0.8 + Math.random() * 0.4),
          ),
        ),
      );
      const selected = new Set<GlyphMark>();
      while (selected.size < count) {
        const candidate =
          candidates[Math.floor(Math.random() * candidates.length)];
        if (candidate) selected.add(candidate);
      }

      const speedFactor = 100 / currentConfig.speed;
      const animationGlyphs = Array.from(currentConfig.glyphSet).filter(
        (character) => character.trim().length > 0,
      );
      activeTransitions = Array.from(selected, (mark) => ({
        mark,
        from: mark.glyph,
        to: nextGlyph(
          mark.glyph,
          1 + currentConfig.variation / 50,
          animationGlyphs,
        ),
        delay: Math.random() * 250 * speedFactor,
        duration: (700 + Math.random() * 500) * speedFactor,
      }));

      const startedAt = performance.now();
      const animate = (now: number) => {
        if (!canAnimate()) {
          finishTransitions();
          return;
        }

        let complete = true;
        for (const transition of activeTransitions) {
          clearCell(transition.mark);
          const progress =
            (now - startedAt - transition.delay) / transition.duration;

          if (progress <= 0) {
            drawGlyph(transition.mark, transition.from);
            complete = false;
            continue;
          }

          if (progress < 0.5) {
            drawGlyph(
              transition.mark,
              transition.from,
              1 - smoothstep(progress * 2),
            );
            complete = false;
            continue;
          }

          if (progress < 1) {
            drawGlyph(
              transition.mark,
              transition.to,
              smoothstep((progress - 0.5) * 2),
            );
            complete = false;
            continue;
          }

          drawGlyph(transition.mark, transition.to);
        }

        if (complete) {
          finishTransitions();
          scheduleNext();
          return;
        }

        animationFrame = window.requestAnimationFrame(animate);
      };

      animationFrame = window.requestAnimationFrame(animate);
    };

    const updateActivity = () => {
      if (canAnimate()) {
        scheduleNext();
        return;
      }

      clearTimer();
      finishTransitions();
    };

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry?.isIntersecting ?? false;
        updateActivity();
      },
      { threshold: 0.01 },
    );
    visibilityObserver.observe(canvas);

    const geometryObserver = new ResizeObserver(queueRedraw);
    geometryObserver.observe(canvas);
    const description = document.getElementById("login-description");
    if (description) geometryObserver.observe(description);

    const themeObserver = new MutationObserver(queueRedraw);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const handleVisibilityChange = () => updateActivity();
    const handleMotionChange = () => updateActivity();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionPreference.addEventListener("change", handleMotionChange);

    const initialize = async () => {
      try {
        const response = await fetch(SVG_URL, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Glyph source request failed: ${response.status}`);
        }
        const svgText = await response.text();
        const documentNode = new DOMParser().parseFromString(
          svgText,
          "image/svg+xml",
        );
        const svg = documentNode.documentElement;
        if (svg.nodeName === "parsererror") {
          throw new Error("Glyph source could not be parsed.");
        }

        sourceWidth = Number(svg.getAttribute("width")) || 1200;
        sourceHeight = Number(svg.getAttribute("height")) || 675;
        sourceMarks = Array.from(
          documentNode.querySelectorAll("text"),
          (node) => {
            const opacity = Number(node.getAttribute("fill-opacity")) || 1;
            return {
              x: Number(node.getAttribute("x")),
              y: Number(node.getAttribute("y")),
              glyph: node.textContent || ".",
              opacity,
              size: Number(node.getAttribute("font-size")) || 6,
              weight: Number(node.getAttribute("font-weight")) || 500,
              density: clamp((opacity - 0.28) / 0.72),
            };
          },
        ).filter(
          (mark) =>
            Number.isFinite(mark.x) &&
            Number.isFinite(mark.y) &&
            mark.glyph.length > 0,
        );
        if (disposed || sourceMarks.length === 0) return;

        const xPositions = [...new Set(sourceMarks.map((mark) => mark.x))].sort(
          (a, b) => a - b,
        );
        const yPositions = [...new Set(sourceMarks.map((mark) => mark.y))].sort(
          (a, b) => a - b,
        );
        gridWidth = (xPositions[1] ?? 6) - (xPositions[0] ?? 0) || 6;
        gridHeight = (yPositions[1] ?? 6.36) - (yPositions[0] ?? 0) || 6.36;
        rebuildMarks();
        renderScene();

        initialized = true;
        setReady(true);
        scheduleNext(true);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Glyph hero animation could not start.", error);
        }
      }
    };

    void initialize();

    return () => {
      disposed = true;
      controller.abort();
      clearTimer();
      clearFrame();
      if (redrawFrame !== undefined) window.cancelAnimationFrame(redrawFrame);
      visibilityObserver.disconnect();
      geometryObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionChange);
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0"
      aria-hidden="true"
    >
      <div
        className={`absolute inset-0 bg-[url('/assets/glyph-hero.svg')] bg-cover bg-right-top bg-no-repeat max-sm:bg-[length:auto_100%] ${ready ? "opacity-0" : "opacity-100"}`}
      />
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full object-cover object-right-top ${ready ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
};

export default LoginGlyphCanvas;
