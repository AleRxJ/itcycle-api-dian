/**
 * Abstraction over wherever a document's signed XML actually lives.
 * `Invoice.xmlReference` (etc., see prisma/schema.prisma) is the only thing
 * ITCycle persists in its own row — the XML itself is fetched through this
 * interface, e.g. when retrying a CONTINGENCY document's send() with DIAN.
 *
 * Unlike CertificateSecretStore, the XML is not a secret (it's the legal
 * document itself) — no encryption is required, only that it not be lost.
 * See {@link LocalFileDocumentXmlStore} for the local-development stand-in.
 */
export interface DocumentXmlStore {
  save(xmlReference: string, signedXml: string): Promise<void>;
  get(xmlReference: string): Promise<string>;
  delete(xmlReference: string): Promise<void>;
}
