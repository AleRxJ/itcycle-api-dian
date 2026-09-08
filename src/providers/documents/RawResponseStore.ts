/**
 * Abstraction over wherever a document's raw DIAN response actually lives -
 * the exact SOAP XML DIAN returned for a send or a getStatusZip poll (see
 * dian-engine's DianSendResponse.rawResponse/DianStatusResponse.rawResponse).
 * `Invoice.dianResponseReference` (etc., see prisma/schema.prisma) is the
 * only thing ITCycle persists in its own row.
 *
 * Exists because a genuine DIAN rejection can come back with no
 * statusDescription and no errors at all - without the raw response saved
 * somewhere, there is nothing to inspect to find out why. Same non-secret,
 * durability-only motivation as {@link DocumentXmlStore} - not encrypted.
 * Only the LATEST response for a document is kept (upsert, not append).
 */
export interface RawResponseStore {
  save(reference: string, rawResponse: string): Promise<void>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}
