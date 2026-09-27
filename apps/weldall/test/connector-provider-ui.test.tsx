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
  it("offers both providers without deployment configuration", () => {
    const html = renderToStaticMarkup(<EnvelopeProviderField existing={false} value="LOCAL_ENV" />);
    expect(html).toContain('value="LOCAL_ENV" selected=""');
    expect(html).toContain('value="OPENBAO"');
    expect(html).not.toContain('value="OPENBAO" disabled');
    expect(html).not.toContain("Upcoming");
    expect(html).not.toContain('<select aria-label="Envelope provider" disabled');
  });
  it("shows the selected provider read-only on edit", () => {
    const html = renderToStaticMarkup(<EnvelopeProviderField existing value="OPENBAO" />);
    expect(html).toContain('<select aria-label="Envelope provider" disabled=""');
    expect(html).toContain('value="OPENBAO" selected=""');
  });
});
