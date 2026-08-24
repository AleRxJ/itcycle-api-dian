import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import { PrismaDocumentXmlStore } from "./PrismaDocumentXmlStore.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PrismaDocumentXmlStore", () => {
  it("round-trips signed XML through save/get", async () => {
    const store = new PrismaDocumentXmlStore(prisma);
    const reference = randomUUID();
    const xml = "<Invoice>fake signed xml</Invoice>";

    try {
      await store.save(reference, xml);
      expect(await store.get(reference)).toBe(xml);
    } finally {
      await store.delete(reference);
    }
  });

  it("save is idempotent (upsert) for the same reference", async () => {
    const store = new PrismaDocumentXmlStore(prisma);
    const reference = randomUUID();

    try {
      await store.save(reference, "<Invoice>first</Invoice>");
      await store.save(reference, "<Invoice>second</Invoice>");

      expect(await store.get(reference)).toBe("<Invoice>second</Invoice>");
    } finally {
      await store.delete(reference);
    }
  });

  it("delete removes the row", async () => {
    const store = new PrismaDocumentXmlStore(prisma);
    const reference = randomUUID();
    await store.save(reference, "<Invoice>data</Invoice>");

    await store.delete(reference);

    await expect(store.get(reference)).rejects.toThrow();
  });

  it("get rejects an unknown reference", async () => {
    const store = new PrismaDocumentXmlStore(prisma);
    await expect(store.get(randomUUID())).rejects.toThrow();
  });
});
