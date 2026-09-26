"use client";

import { Selector } from "@astryxdesign/core/Selector";

/** The only enabled provider is deployment-wide and becomes immutable on creation. */
export function EnvelopeProviderField({ existing }: { existing: boolean }) {
  return (
    <Selector
      label="Envelope provider"
      description={
        existing
          ? "Selected at creation; cannot be changed."
          : "OpenBao is upcoming and not yet supported."
      }
      isRequired
      isDisabled={existing}
      value="LOCAL_ENV"
      options={[
        { value: "LOCAL_ENV", label: "Local environment key" },
        { value: "OPENBAO", label: "OpenBao — Upcoming", disabled: true },
      ]}
      width="100%"
    />
  );
}
