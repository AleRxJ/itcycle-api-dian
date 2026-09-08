import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RawResponseStore } from "./RawResponseStore.js";

/**
 * Filesystem-backed {@link RawResponseStore}. Stores each document's raw
 * DIAN response as `<baseDir>/<ref>.xml`. `baseDir` must stay outside of
 * git, same convention as CERTIFICATES_DIR/DOCUMENTS_DIR - swap this for a
 * proper store (S3/blob storage) when deploying for real.
 */
export class LocalFileRawResponseStore implements RawResponseStore {
  constructor(private readonly baseDir: string) {}

  async save(reference: string, rawResponse: string): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.path(reference), rawResponse, "utf-8");
  }

  async get(reference: string): Promise<string> {
    return readFile(this.path(reference), "utf-8");
  }

  async delete(reference: string): Promise<void> {
    await rm(this.path(reference), { force: true });
  }

  private path(reference: string): string {
    return join(this.baseDir, `${reference}.xml`);
  }
}
