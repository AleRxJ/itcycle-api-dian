import type { PrismaClient } from "@prisma/client";

import type { RawResponseStore } from "./RawResponseStore.js";

/**
 * Postgres-backed {@link RawResponseStore} (via Prisma's DianResponseBlob
 * table). Same motivation as {@link PrismaDocumentXmlStore}: works without a
 * persistent disk. See STORAGE_DRIVER in src/shared/env.ts.
 */
export class PrismaRawResponseStore implements RawResponseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(reference: string, rawResponse: string): Promise<void> {
    await this.prisma.dianResponseBlob.upsert({
      where: { reference },
      create: { reference, rawResponse },
      update: { rawResponse },
    });
  }

  async get(reference: string): Promise<string> {
    const row = await this.prisma.dianResponseBlob.findUniqueOrThrow({ where: { reference } });
    return row.rawResponse;
  }

  async delete(reference: string): Promise<void> {
    await this.prisma.dianResponseBlob.deleteMany({ where: { reference } });
  }
}
