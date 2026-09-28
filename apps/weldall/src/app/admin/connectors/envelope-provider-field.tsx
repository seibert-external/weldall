"use client";

import { Selector } from "@astryxdesign/core/Selector";

type Provider = "LOCAL_ENV" | "OPENBAO";

/** Provider choice is unconditional and becomes immutable on creation. */
export function EnvelopeProviderField({
  existing,
  value,
  onChange,
}: {
  existing: boolean;
  value: Provider;
  onChange?: (value: Provider) => void;
}) {
  return (
    <Selector
      label="Envelope provider"
      description={
        existing
          ? "Selected at creation; cannot be changed."
          : "Choose how connection credentials are protected."
      }
      isRequired
      isDisabled={existing}
      value={value}
      onChange={(next) => {
        if (next === "LOCAL_ENV" || next === "OPENBAO") onChange?.(next);
      }}
      options={[
        { value: "LOCAL_ENV", label: "Local environment key" },
        { value: "OPENBAO", label: "OpenBao" },
      ]}
      width="100%"
    />
  );
}
