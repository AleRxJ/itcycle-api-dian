import type {
  DianKitConfig,
  DianNumberingRangeResponse,
  DianSendResponse,
  DianStatusResponse,
  DianAcquirerResponse,
  DocumentResult,
} from "@dian-kit/sdk-node";

import { DianKitProvider } from "./DianKitProvider.js";
import type { DianProvider } from "./DianProvider.js";

const SIMULATED_NOTICE =
  "[SIMULADO] Documento generado y firmado localmente por dian-kit; NO fue enviado a la DIAN.";

/**
 * DianProvider for local development and demos when there is no real DIAN
 * habilitación registration yet.
 *
 * `createInvoice`/`createCreditNote`/`createDebitNote` delegate to a real
 * {@link DianKitProvider} — the UBL 2.1 XML, CUFE/CUDE, and XAdES-EPES
 * signature are all genuinely produced by dian-kit, nothing about that is
 * faked. Only `send`/`getStatus`/`getStatusZip` are short-circuited with a
 * canned "accepted" response, because reaching DIAN's real SOAP service can
 * only ever succeed against a real registration (NIT, Software ID/PIN,
 * numbering resolution, technical key, ONAC-issued certificate).
 * `getNumberingRange`/`lookupBuyer` are not simulated at all — they'd have
 * to invent DIAN registry data, which nobody should trust — they throw.
 *
 * A response from this provider is NEVER a real DIAN acceptance. It exists
 * purely to unblock local development/demos of everything *around* the DIAN
 * call — see docs/dian/simulation.md. The actual Fase 4 milestone still
 * requires DianKitProvider against a real DIAN Sandbox test company.
 */
export class SimulatedDianProvider implements DianProvider {
  private readonly real: DianKitProvider;

  constructor(config: DianKitConfig) {
    this.real = new DianKitProvider(config);
  }

  createInvoice: DianProvider["createInvoice"] = (input) => this.real.createInvoice(input);

  createCreditNote: DianProvider["createCreditNote"] = (input) => this.real.createCreditNote(input);

  createDebitNote: DianProvider["createDebitNote"] = (input) => this.real.createDebitNote(input);

  async send(document: DocumentResult): Promise<DianSendResponse> {
    return {
      isValid: true,
      statusCode: "00",
      statusDescription: SIMULATED_NOTICE,
      trackId: `simulated-${document.uuid}`,
      errors: [],
      rawResponse: "",
    };
  }

  async getStatus(): Promise<DianStatusResponse> {
    return { isValid: true, statusCode: "00", statusDescription: SIMULATED_NOTICE, errors: [], rawResponse: "" };
  }

  async getStatusZip(): Promise<DianStatusResponse> {
    return { isValid: true, statusCode: "00", statusDescription: SIMULATED_NOTICE, errors: [], rawResponse: "" };
  }

  async getNumberingRange(): Promise<DianNumberingRangeResponse> {
    throw new Error(
      "SimulatedDianProvider does not support getNumberingRange: it would require inventing DIAN registry data. Use DianKitProvider against a real registration instead.",
    );
  }

  async lookupBuyer(): Promise<DianAcquirerResponse> {
    throw new Error(
      "SimulatedDianProvider does not support lookupBuyer: it would require inventing DIAN registry data. Use DianKitProvider against a real registration instead.",
    );
  }
}
