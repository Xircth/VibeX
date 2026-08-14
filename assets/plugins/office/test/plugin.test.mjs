import assert from "node:assert/strict";
import test from "node:test";

import {
  createPermissionHost,
  createWorkerHarness,
} from "@vibex/plugin-sdk/testing";

import definition from "../runtime/worker.mjs";

test("routes Office preview through the declared Artifact capability", async () => {
  const host = createPermissionHost([
    {
      capability: "artifact.preview",
      operations: ["open"],
      allows: (input) => input?.providerId === "office-preview",
      response: { leaseId: "office-preview-test" },
    },
  ]);
  const worker = await createWorkerHarness(definition, { host });

  assert.deepEqual(worker.handlers, ["office-preview"]);
  assert.deepEqual(
    await worker.invoke("office-preview", {
      providerId: "office-preview",
      artifactHandle: "artifact-test",
    }),
    { leaseId: "office-preview-test" },
  );
  await assert.rejects(
    () =>
      worker.invoke("office-preview", {
        providerId: "other-preview",
        artifactHandle: "artifact-test",
      }),
    /scope/i,
  );
  await worker.dispose();
});
