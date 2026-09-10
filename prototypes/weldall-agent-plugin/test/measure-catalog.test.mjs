import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { measure, trimCatalog } from "../scripts/measure-catalog.mjs";

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "skills-list.json"), "utf8"),
);

test("trimming keeps warnings untouched, because a branch depends on them", () => {
  assert.deepEqual(trimCatalog(fixture).warnings, fixture.warnings);
});

test("trimming keeps every field the outcome table branches on", () => {
  const trimmed = trimCatalog(fixture);
  assert.equal(trimmed.items.length, 2);
  assert.deepEqual(trimmed.items[0], {
    slug: "expenses.review",
    title: "Review expenses",
    preview: "Use this skill to list the expenses this user may see.",
    available: true,
    tags: ["expenses", "review"],
    source: "Expenses demo",
  });
  assert.deepEqual(trimmed.items[1], {
    slug: "contracts.manage",
    title: "Manage contracts",
    preview: "Search contracts and change a review date.",
    available: false,
    missingScopes: ["contracts:update"],
    tags: ["contracts", "review"],
    source: "Contracts demo",
  });
});

test("trimming drops the fields no agent reads", () => {
  const serialized = JSON.stringify(trimCatalog(fixture));
  for (const dropped of [
    "visibility",
    "updatedAt",
    "lastUpdatedAt",
    "appearance",
    "requiredScopes",
    "owner",
  ])
    assert.ok(!serialized.includes(dropped), `the trimmed payload still carries ${dropped}`);
});

test("an admin-published skill reports Weldall as its source", () => {
  const trimmed = trimCatalog({
    warnings: [],
    items: [{ ...fixture.items[0], source: { type: "admin" } }],
  });
  assert.equal(trimmed.items[0].source, "Weldall");
});

test("measure reports utf-8 bytes and a token estimate of a quarter of them", () => {
  assert.deepEqual(measure({ a: "bc" }), { bytes: 10, tokens: 3 });
  assert.equal(measure({ a: "ü" }).bytes, 10);
});

test("trimming the fixture actually saves bytes", () => {
  assert.ok(measure(trimCatalog(fixture)).bytes < measure(fixture).bytes);
});

test("trimming omits tags when meta is absent or has no tags field", () => {
  const noMeta = trimCatalog({
    warnings: [],
    items: [
      {
        slug: "test.noMeta",
        title: "Test",
        preview: "No meta",
        available: true,
        source: { type: "resource", name: "Test" },
      },
    ],
  });
  assert.ok(!("tags" in noMeta.items[0]), "tags should not exist when meta is absent");

  const metaNoTags = trimCatalog({
    warnings: [],
    items: [
      {
        slug: "test.metaNoTags",
        title: "Test",
        preview: "Meta without tags",
        available: true,
        meta: {},
        source: { type: "resource", name: "Test" },
      },
    ],
  });
  assert.ok(!("tags" in metaNoTags.items[0]), "tags should not exist when meta has no tags field");
});
