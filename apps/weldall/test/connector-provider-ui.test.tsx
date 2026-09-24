import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnvelopeProviderField } from "../src/app/admin/connectors/envelope-provider-field";

// Render the selector contract as native HTML so every option is inspectable without a portal.
vi.mock("@astryxdesign/core/Selector", () => ({
  Selector: ({
    label,
    isDisabled,
    value,
    options,
  }: {
    label: string;
    isDisabled: boolean;
    value: string;
    options: { value: string; label: string; disabled?: boolean }[];
  }) => (
    <select aria-label={label} disabled={isDisabled} defaultValue={value}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
describe("envelope provider selector", () => {
  it("offers Local environment key and renders OpenBao disabled as Upcoming", () => {
    const html = renderToStaticMarkup(<EnvelopeProviderField existing={false} />);
    expect(html).toContain('value="LOCAL_ENV" selected=""');
    expect(html).toContain('value="OPENBAO" disabled=""');
    expect(html).toContain("OpenBao — Upcoming");
    expect(html).not.toContain('<select aria-label="Envelope provider" disabled');
  });
  it("shows the selected provider read-only on edit", () => {
    expect(renderToStaticMarkup(<EnvelopeProviderField existing />)).toContain(
      '<select aria-label="Envelope provider" disabled=""',
    );
  });
});
