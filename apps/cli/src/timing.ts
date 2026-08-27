import { performance } from "node:perf_hooks";

export const timingNow = () => performance.now();

export const phaseTiming = (name: string, startedAt: number) => {
  if (process.env.WELDALL_DEBUG_TIMINGS !== undefined)
    console.error(
      `${name.padEnd(18)} ${Math.max(0, Math.round(performance.now() - startedAt))} ms`,
    );
};
