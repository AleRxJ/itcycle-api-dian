import { prisma } from "../infrastructure/prisma.js";
import { LocalFileDocumentXmlStore } from "../providers/documents/LocalFileDocumentXmlStore.js";
import { PrismaDocumentXmlStore } from "../providers/documents/PrismaDocumentXmlStore.js";
import type { DocumentXmlStore } from "../providers/documents/DocumentXmlStore.js";
import { env } from "./env.js";

/**
 * Default DocumentXmlStore for the production document services. Evaluated
 * lazily (called per-invocation, never a module-level constant) so tests
 * that inject their own store never depend on DOCUMENTS_DIR existing.
 */
export function createDefaultDocumentXmlStore(): DocumentXmlStore {
  if (env.storageDriver === "database") {
    return new PrismaDocumentXmlStore(prisma);
  }
  return new LocalFileDocumentXmlStore(env.documentsDir);
}
