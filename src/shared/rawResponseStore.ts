import { prisma } from "../infrastructure/prisma.js";
import { LocalFileRawResponseStore } from "../providers/documents/LocalFileRawResponseStore.js";
import { PrismaRawResponseStore } from "../providers/documents/PrismaRawResponseStore.js";
import type { RawResponseStore } from "../providers/documents/RawResponseStore.js";
import { env } from "./env.js";

/**
 * Default RawResponseStore for the production document services. Evaluated
 * lazily (called per-invocation, never a module-level constant) so tests
 * that inject their own store never depend on RAW_RESPONSES_DIR existing.
 */
export function createDefaultRawResponseStore(): RawResponseStore {
  if (env.storageDriver === "database") {
    return new PrismaRawResponseStore(prisma);
  }
  return new LocalFileRawResponseStore(env.rawResponsesDir);
}
