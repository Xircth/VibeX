import assert from "node:assert/strict";
import test from "node:test";

import {
  auditCargoMetadata,
  auditPnpmLicenses,
} from "./check-dependency-licenses.mjs";

test("rejects an unreviewed JavaScript package with an unknown license", () => {
  assert.throws(
    () =>
      auditPnpmLicenses({
        Unknown: [{ name: "mystery", versions: ["1.0.0"] }],
      }),
    /mystery@1.0.0/,
  );
});

test("accepts the reviewed khroma MIT license-file exception", () => {
  assert.doesNotThrow(() =>
    auditPnpmLicenses({
      Unknown: [{ name: "khroma", versions: ["2.1.0"] }],
    }),
  );
});

test("rejects a registry Rust dependency without license metadata", () => {
  assert.throws(
    () =>
      auditCargoMetadata({
        packages: [
          {
            name: "mystery",
            version: "1.0.0",
            source: "registry+https://example.invalid",
            license: null,
          },
        ],
      }),
    /mystery@1.0.0/,
  );
});

test("allows a permissive alternative in an SPDX Rust expression", () => {
  assert.doesNotThrow(() =>
    auditCargoMetadata({
      packages: [
        {
          name: "choice",
          version: "1.0.0",
          source: "registry+https://example.invalid",
          license: "MIT OR LGPL-2.1-or-later",
        },
      ],
    }),
  );
});
