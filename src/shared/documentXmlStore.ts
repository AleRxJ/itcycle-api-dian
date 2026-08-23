import { LocalFileDocumentXmlStore } from "../providers/documents/LocalFileDocumentXmlStore.js";
import type { DocumentXmlStore } from "../providers/documents/DocumentXmlStore.js";
import { env } from "./env.js";

/**
 * Default DocumentXmlStore for the production document services. Evaluated
 * lazily (called per-invocation, never a module-level constant) so tests
 * that inject their own store never depend on DOCUMENTS_DIR existing.
 */
export function createDefaultDocumentXmlStore(): DocumentXmlStore {
  return new LocalFileDocumentXmlStore(env.documentsDir);
}
