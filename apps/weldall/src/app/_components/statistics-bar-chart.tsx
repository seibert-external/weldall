"use client";

import { barX, defineChart } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useMemo } from "react";

export interface StatisticsBarRow {
  /** Unique per row. Two resources may share a name, so the band scale never keys by label. */
  key: string;
  label: string;
  value: number;
}

const ROW_HEIGHT = 32;
const AXIS_HEIGHT = 48;

export function StatisticsBarChart({
  rows,
  ariaLabel,
  valueLabel,
}: {
  rows: readonly StatisticsBarRow[];
  ariaLabel: string;
  valueLabel: string;
}) {
  const definition = useMemo(() => {
    const labels = new Map(rows.map((row) => [row.key, row.label] as const));
    return defineChart({
      marks: [barX([...rows], { x: "value", y: "key", inset: 2, radius: 3 })],
      scales: {
        x: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: {
            label: valueLabel,
            ticks: { format: (value: number) => (Number.isInteger(value) ? String(value) : "") },
          },
        },
        y: {
          scale: () => scaleBand<string>().paddingInner(0.12).paddingOuter(0.06),
          axis: { ticks: { format: (key: string) => labels.get(key) ?? key } },
        },
      },
    });
  }, [rows, valueLabel]);

  return (
    <Chart
      definition={definition}
      height={rows.length * ROW_HEIGHT + AXIS_HEIGHT}
      ariaLabel={ariaLabel}
    />
  );
}
