import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const model = (name: string) => {
  const result = Prisma.dmmf.datamodel.models.find((entry) => entry.name === name);
  if (!result) throw new Error(`Missing model: ${name}`);
  return result;
};

describe("personal connection persistence boundary", () => {
  it("requires an owner and device without a credential-mode union or durable provider secrets", () => {
    const fields = model("PersonalConnection").fields;
    for (const name of ["ownerId", "deviceId", "connectorId"]) {
      expect(fields.find((field) => field.name === name)).toMatchObject({
        type: "String",
        isRequired: true,
      });
    }
    const names = fields.map((field) => field.name);
    expect(names).not.toContain("credentialMode");
    expect(names).not.toContain("accessToken");
    expect(names).not.toContain("refreshToken");
    expect(names).not.toContain("encryptedCredentials");
  });

  it("keeps temporary handoffs separate from connection metadata", () => {
    const fields = model("PersonalConnectionAuthorization").fields;
    expect(fields.find((field) => field.name === "expiresAt")).toMatchObject({
      type: "DateTime",
      isRequired: true,
    });
    expect(fields.find((field) => field.name === "encryptedCredentials")).toMatchObject({
      type: "String",
      isRequired: false,
    });
    expect(
      model("Connector").fields.find((field) => field.name === "personalConnections"),
    ).toMatchObject({ type: "PersonalConnection", isList: true });
  });

  it("does not introduce a shared-connection placeholder or retain the generic connection model", () => {
    const names = Prisma.dmmf.datamodel.models.map((entry) => entry.name);
    expect(names).not.toContain("ConnectorConnection");
    expect(names).not.toContain("ConnectorAuthorization");
    expect(names).not.toContain("SharedConnection");
  });
});
