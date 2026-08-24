import type { PrismaClient } from "@prisma/client";

import type { DocumentXmlStore } from "./DocumentXmlStore.js";

/**
 * Postgres-backed {@link DocumentXmlStore} (via Prisma's DocumentXmlBlob
 * table). Same motivation as {@link PrismaCertificateSecretStore}: works
 * without a persistent disk. The XML isn't a secret, so no encryption —
 * just durability. See STORAGE_DRIVER in src/shared/env.ts.
 */
export class PrismaDocumentXmlStore implements DocumentXmlStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(xmlReference: string, signedXml: string): Promise<void> {
    await this.prisma.documentXmlBlob.upsert({
      where: { reference: xmlReference },
      create: { reference: xmlReference, xml: signedXml },
      update: { xml: signedXml },
    });
  }

  async get(xmlReference: string): Promise<string> {
    const row = await this.prisma.documentXmlBlob.findUniqueOrThrow({ where: { reference: xmlReference } });
    return row.xml;
  }

  async delete(xmlReference: string): Promise<void> {
    await this.prisma.documentXmlBlob.deleteMany({ where: { reference: xmlReference } });
  }
}
