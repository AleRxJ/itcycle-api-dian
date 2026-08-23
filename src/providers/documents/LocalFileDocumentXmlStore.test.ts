import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileDocumentXmlStore } from "./LocalFileDocumentXmlStore.js";

let baseDir: string;
let store: LocalFileDocumentXmlStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "itcycle-document-xml-"));
  store = new LocalFileDocumentXmlStore(baseDir);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("LocalFileDocumentXmlStore", () => {
  it("round-trips signed XML through save/get", async () => {
    await store.save("ref-1", "<Invoice>signed xml here</Invoice>");
    expect(await store.get("ref-1")).toBe("<Invoice>signed xml here</Invoice>");
  });

  it("deletes the stored XML", async () => {
    await store.save("ref-2", "<Invoice/>");
    await store.delete("ref-2");
    await expect(store.get("ref-2")).rejects.toThrow();
  });
});
