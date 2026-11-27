import { expect, open, test } from "nsh/test";
import {
  ensureRpcResultSchema,
  isExternalRpcSchemaCatalog,
  rpcResultSchemaIssue,
  setExternalRpcSchemaLoaderForTest,
} from "./backend/rpcResultSchema";

test("R3 Code opens its main window cleanly on Windows NSH v0.7", async () => {
  const app = await open("./App.tsx", { platform: "windows", width: 1280, height: 840 });
  await app.waitUntil(() => app.window("main").state()?.visible === true, { timeout: 5000 });
  expect(app.window("main").state()).toMatchObject({ visible: true });
  expect(app.texts().length).toBeGreaterThan(0);
});

test("staged Windows bundle externalizes RPC schemas and fails closed until loaded", async () => {
  expect(isExternalRpcSchemaCatalog()).toBe(true);
  expect(rpcResultSchemaIssue("vcs.listRefs", {})).toBe("RPC result schema was not loaded before decoding.");
  setExternalRpcSchemaLoaderForTest(async (method) => {
    if (method === "vcs.listRefs") {
      return {
        found: true,
        schema: { type: "object", required: ["branches"], properties: { branches: { type: "array" } } },
        definitions: {},
      };
    }
    return { found: false };
  });
  try {
    await ensureRpcResultSchema("vcs.listRefs");
    expect(rpcResultSchemaIssue("vcs.listRefs", {})).toContain("Missing key");
    expect(rpcResultSchemaIssue("vcs.listRefs", { branches: [] })).toBe(null);
  } finally {
    setExternalRpcSchemaLoaderForTest(null);
  }
});
