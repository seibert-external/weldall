import {
  Children,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefAttributes,
} from "react";
import {
  motion,
  useInView,
  useReducedMotion,
  type DOMMotionComponents,
  type HTMLMotionProps,
  type MotionProps,
} from "motion/react";

import "./terminal.css";

interface SequenceContextValue {
  activeIndex: number;
  completeItem: (index: number) => void;
  sequenceStarted: boolean;
}

const SequenceContext = createContext<SequenceContextValue | null>(null);
const ItemIndexContext = createContext<number | null>(null);

const motionElements = {
  article: motion.article,
  div: motion.div,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  h5: motion.h5,
  h6: motion.h6,
  li: motion.li,
  p: motion.p,
  section: motion.section,
  span: motion.span,
} as const;

type MotionElementType = Extract<keyof DOMMotionComponents, keyof typeof motionElements>;
type TerminalTypingMotionComponent = ComponentType<
  Omit<HTMLMotionProps<"span">, "ref"> & RefAttributes<HTMLElement>
>;

interface AnimatedSpanProps extends MotionProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  startOnView?: boolean;
}

export const AnimatedSpan = ({
  children,
  className,
  delay = 0,
  startOnView = false,
  ...props
}: AnimatedSpanProps) => {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(elementRef, { amount: 0.3, once: true });
  const prefersReducedMotion = useReducedMotion();
  const sequence = useContext(SequenceContext);
  const itemIndex = useContext(ItemIndexContext);
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    if (
      sequence?.sequenceStarted &&
      itemIndex !== null &&
      sequence.activeIndex === itemIndex &&
      !hasStarted
    ) {
      setHasStarted(true);
    }
  }, [hasStarted, itemIndex, sequence]);

  const shouldAnimate = sequence ? hasStarted : startOnView ? isInView : true;

  return (
    <motion.div
      ref={elementRef}
      initial={{ opacity: 0, y: -5 }}
      animate={shouldAnimate ? { opacity: 1, y: 0 } : { opacity: 0, y: -5 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.3, delay: sequence ? 0 : delay / 1000 }}
      className={["magic-terminal__line", className].filter(Boolean).join(" ")}
      onAnimationComplete={() => {
        if (sequence && itemIndex !== null) sequence.completeItem(itemIndex);
      }}
      {...props}
    >
      {children}
    </motion.div>
  );
};

interface TypingAnimationProps extends Omit<MotionProps, "children"> {
  children: string;
  as?: MotionElementType;
  className?: string;
  delay?: number;
  duration?: number;
  startOnView?: boolean;
}

export const TypingAnimation = ({
  children,
  as: Component = "span",
  className,
  delay = 0,
  duration = 60,
  startOnView = true,
  ...props
}: TypingAnimationProps) => {
  const MotionComponent = motionElements[Component] as TerminalTypingMotionComponent;
  const elementRef = useRef<HTMLElement | null>(null);
  const isInView = useInView(elementRef, { amount: 0.3, once: true });
  const prefersReducedMotion = useReducedMotion();
  const sequence = useContext(SequenceContext);
  const itemIndex = useContext(ItemIndexContext);
  const hasSequence = sequence !== null;
  const sequenceStarted = sequence?.sequenceStarted ?? false;
  const sequenceActiveIndex = sequence?.activeIndex ?? null;
  const sequenceCompleteItemRef = useRef<SequenceContextValue["completeItem"] | null>(null);
  const sequenceItemIndexRef = useRef<number | null>(null);
  const [displayedText, setDisplayedText] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    sequenceCompleteItemRef.current = sequence?.completeItem ?? null;
    sequenceItemIndexRef.current = itemIndex;
  }, [itemIndex, sequence?.completeItem]);

  useEffect(() => {
    let startTimeout: ReturnType<typeof setTimeout> | undefined;

    if (hasSequence && itemIndex !== null) {
      if (sequenceStarted && sequenceActiveIndex === itemIndex && !started) {
        setStarted(true);
      }
    } else if (!startOnView || isInView) {
      startTimeout = setTimeout(() => setStarted(true), delay);
    }

    return () => clearTimeout(startTimeout);
  }, [
    delay,
    hasSequence,
    isInView,
    itemIndex,
    sequenceActiveIndex,
    sequenceStarted,
    started,
    startOnView,
  ]);

  useEffect(() => {
    if (!started) return;

    const completeSequenceItem = () => {
      const completeItem = sequenceCompleteItemRef.current;
      const currentItemIndex = sequenceItemIndexRef.current;
      if (completeItem && currentItemIndex !== null) completeItem(currentItemIndex);
    };

    if (prefersReducedMotion) {
      setDisplayedText(children);
      completeSequenceItem();
      return;
    }

    let characterIndex = 0;
    const typingEffect = setInterval(() => {
      if (characterIndex < children.length) {
        setDisplayedText(children.substring(0, characterIndex + 1));
        characterIndex += 1;
        return;
      }

      clearInterval(typingEffect);
      completeSequenceItem();
    }, duration);

    return () => clearInterval(typingEffect);
  }, [children, duration, prefersReducedMotion, started]);

  return (
    <MotionComponent
      ref={elementRef}
      className={["magic-terminal__line", className].filter(Boolean).join(" ")}
      {...props}
    >
      {displayedText}
    </MotionComponent>
  );
};

interface TerminalProps {
  children: ReactNode;
  className?: string;
  sequence?: boolean;
  startOnView?: boolean;
}

// Adapted from Magic UI's Terminal component:
// https://magicui.design/docs/components/terminal
export const Terminal = ({
  children,
  className,
  sequence = true,
  startOnView = true,
}: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(containerRef, { amount: 0.3, once: true });
  const [activeIndex, setActiveIndex] = useState(0);
  const sequenceStarted = sequence ? !startOnView || isInView : false;

  const contextValue = useMemo<SequenceContextValue | null>(() => {
    if (!sequence) return null;

    return {
      activeIndex,
      completeItem: (index) => {
        setActiveIndex((current) => (index === current ? current + 1 : current));
      },
      sequenceStarted,
    };
  }, [activeIndex, sequence, sequenceStarted]);

  const wrappedChildren = useMemo(() => {
    if (!sequence) return children;

    return Children.toArray(children).map((child, index) => (
      <ItemIndexContext.Provider key={index} value={index}>
        {child}
      </ItemIndexContext.Provider>
    ));
  }, [children, sequence]);

  const content = (
    <div ref={containerRef} className={["magic-terminal", className].filter(Boolean).join(" ")}>
      <div className="magic-terminal__header" aria-hidden="true">
        <span className="magic-terminal__dot magic-terminal__dot--red" />
        <span className="magic-terminal__dot magic-terminal__dot--yellow" />
        <span className="magic-terminal__dot magic-terminal__dot--green" />
      </div>
      <pre className="magic-terminal__body">
        <code>{wrappedChildren}</code>
      </pre>
    </div>
  );

  if (!sequence) return content;

  return <SequenceContext.Provider value={contextValue}>{content}</SequenceContext.Provider>;
};
