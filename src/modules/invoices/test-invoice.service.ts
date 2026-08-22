import type { DianKitConfig, InvoiceInput, Party, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import { LocalFileCertificateSecretStore } from "../../providers/certificates/LocalFileCertificateSecretStore.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import { env } from "../../shared/env.js";

const defaultSecretStore = new LocalFileCertificateSecretStore(env.certificatesDir);

function defaultCreateProvider(config: DianKitConfig): DianProvider {
  // DIAN_SIMULATION_MODE unblocks local dev/demos without a real DIAN
  // Sandbox registration — dian-kit still builds/signs a real document, only
  // the send to DIAN itself is simulated. See docs/dian/simulation.md.
  return env.dianSimulationMode ? new SimulatedDianProvider(config) : new DianKitProvider(config);
}

export interface TestInvoiceParams {
  companyId: string;
  internalReference: string;
  invoice: Record<string, unknown>;
  send?: SendOptions;
}

export interface TestInvoiceDeps {
  /** @defaultValue a LocalFileCertificateSecretStore over CERTIFICATES_DIR */
  secretStore?: CertificateSecretStore;
  /** @defaultValue DianKitProvider, or SimulatedDianProvider when DIAN_SIMULATION_MODE=true */
  createProvider?: (config: DianKitConfig) => DianProvider;
}

/**
 * Dev-only pipeline: load a company's DIAN config, numbering, and test
 * certificate from ITCycle's own database, then delegate everything
 * document-related to a {@link DianProvider} (real DianKitProvider by
 * default). See docs/dian/sandbox-tests.md for how to provision the company
 * this expects.
 */
export async function createTestInvoice(
  params: TestInvoiceParams,
  deps: TestInvoiceDeps = {},
) {
  const secretStore = deps.secretStore ?? defaultSecretStore;
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  // Only the app's own DIAN_SIMULATION_MODE counts as "simulated" for
  // persistence purposes — a caller-injected provider (e.g. in tests) isn't
  // what that flag is meant to record.
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.invoice.findUnique({
    where: {
      companyId_internalReference: {
        companyId: params.companyId,
        internalReference: params.internalReference,
      },
    },
  });
  if (existing) {
    // Idempotent replay: never re-send the same internalReference to DIAN.
    return existing;
  }

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: params.companyId },
    include: { dianConfiguration: true },
  });
  const dianConfiguration = company.dianConfiguration;
  if (!dianConfiguration || !dianConfiguration.supplierProfile) {
    throw new Error(`Company ${params.companyId} has no active DianConfiguration/supplierProfile`);
  }

  const numbering = await prisma.numberingResolution.findFirstOrThrow({
    where: { companyId: params.companyId, status: "ACTIVE" },
  });
  const certificate = await prisma.certificate.findFirstOrThrow({
    where: { companyId: params.companyId, status: "ACTIVE" },
  });

  const invoiceRecord = await prisma.invoice.create({
    data: {
      companyId: params.companyId,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId: certificate.id,
      status: "PROCESSING",
    },
  });

  try {
    const secret = await secretStore.get(certificate.secretReference);

    const config: DianKitConfig = {
      certificate: secret.p12,
      certificatePassword: secret.password,
      environment: dianConfiguration.environment === "PRODUCTION" ? "1" : "2",
      supplier: dianConfiguration.supplierProfile as unknown as Party,
      software: {
        id: dianConfiguration.softwareId,
        pin: dianConfiguration.softwarePin,
        providerNit: company.nit,
        providerName: company.name,
      },
      numbering: {
        authorizationNumber: numbering.resolutionNumber,
        prefix: numbering.prefix,
        startNumber: numbering.startNumber,
        endNumber: numbering.endNumber,
        startDate: numbering.startDate,
        endDate: numbering.endDate,
        technicalKey: dianConfiguration.technicalKey ?? undefined,
      },
    };

    const provider = createProvider(config);
    const invoiceInput = toInvoiceInput(params.invoice);

    const document = await provider.createInvoice(invoiceInput);
    const response = await provider.send(document, params.send);

    return await prisma.invoice.update({
      where: { id: invoiceRecord.id },
      data: {
        invoiceNumber: document.documentNumber,
        prefix: numbering.prefix,
        cufe: document.uuid,
        status: response.isValid ? "ACCEPTED" : "REJECTED",
        simulated,
        issuedAt: new Date(),
        sentAt: new Date(),
        acceptedAt: response.isValid ? new Date() : null,
        errorMessage: response.errors?.map((e) => e.description).join("; ") || null,
      },
    });
  } catch (error) {
    await prisma.invoice.update({
      where: { id: invoiceRecord.id },
      data: {
        status: "ERROR",
        simulated,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/**
 * Converts the JSON request body into dian-kit's InvoiceInput shape.
 * Dates arrive as ISO strings over HTTP; everything else is passed through
 * as-is and validated by dian-kit's own Zod schema inside createInvoice —
 * ITCycle does not duplicate that validation.
 */
function toInvoiceInput(raw: Record<string, unknown>): InvoiceInput {
  return {
    ...raw,
    issueDate: new Date(raw.issueDate as string),
    issueTime: new Date(raw.issueTime as string),
  } as InvoiceInput;
}
