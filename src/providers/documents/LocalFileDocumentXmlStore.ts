import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DocumentXmlStore } from "./DocumentXmlStore.js";

/**
 * Filesystem-backed {@link DocumentXmlStore}. Stores each document's signed
 * XML as `<baseDir>/<ref>.xml`. `baseDir` must stay outside of git (see
 * `.gitignore`), same convention as `CERTIFICATES_DIR` — swap this for a
 * proper document store (S3/blob storage) when deploying for real; the
 * XML itself doesn't need encryption (it's the legal document, not a
 * secret), just durability.
 */
export class LocalFileDocumentXmlStore implements DocumentXmlStore {
  constructor(private readonly baseDir: string) {}

  async save(xmlReference: string, signedXml: string): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.path(xmlReference), signedXml, "utf-8");
  }

  async get(xmlReference: string): Promise<string> {
    return readFile(this.path(xmlReference), "utf-8");
  }

  async delete(xmlReference: string): Promise<void> {
    await rm(this.path(xmlReference), { force: true });
  }

  private path(xmlReference: string): string {
    return join(this.baseDir, `${xmlReference}.xml`);
  }
}
