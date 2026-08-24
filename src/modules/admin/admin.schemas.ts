import { z } from "zod";

export const CreateCompanyBodySchema = z.object({
  name: z.string(),
  nit: z.string(),
  dv: z.string(),
  personType: z.string(),
});

export const SetDianConfigurationBodySchema = z.object({
  environment: z.enum(["PRODUCTION", "SANDBOX"]),
  softwareId: z.string(),
  softwarePin: z.string(),
  technicalKey: z.string().optional(),
  // Full dian-kit Party shape for the supplier — see prisma/schema.prisma's
  // DianConfiguration.supplierProfile comment. Not re-validated field by
  // field here; dian-kit's own Zod schema validates it at issuance time.
  supplierProfile: z.record(z.string(), z.unknown()),
});

export const CreateNumberingResolutionBodySchema = z.object({
  documentType: z.enum(["01", "91", "92", "05"]),
  prefix: z.string(),
  resolutionNumber: z.string(),
  startNumber: z.number().int(),
  endNumber: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
});

export const UploadCertificateBodySchema = z.object({
  provider: z.string(),
  certificateIdentifier: z.string(),
  p12Base64: z.string(),
  password: z.string(),
  expiresAt: z.string(),
});

export const CreateApiKeyBodySchema = z.object({
  label: z.string(),
});

export const SetFirmaPassLoginKeyBodySchema = z.object({
  loginKey: z.string(),
});

export const FirmaPassUploadRutBodySchema = z.object({
  rutBase64: z.string(),
  identificacionRepresentanteLegal: z.string().optional(),
});

export const FirmaPassUploadArchivoBodySchema = z.object({
  type: z.string(),
  fileBase64: z.string(),
});
