import type { FastifyInstance } from "fastify";

import {
  CreateApiKeyBodySchema,
  CreateCompanyBodySchema,
  CreateNumberingResolutionBodySchema,
  CreateViafirmaRequestBodySchema,
  FirmaPassUploadArchivoBodySchema,
  FirmaPassUploadRutBodySchema,
  SetCertificateProviderOverrideBodySchema,
  SetDianConfigurationBodySchema,
  UpdateNumberingResolutionBodySchema,
  UploadCertificateBodySchema,
  ViafirmaRevokeBodySchema,
  ViafirmaUploadDocumentBodySchema,
} from "./admin.schemas.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  getCertificateProviderStatus,
  getDianRawResponse,
  getDianReadiness,
  getFirmaPassStatus,
  listTestSubmissions,
  refreshDocumentStatus,
  setCertificateProviderOverride,
  setDianConfiguration,
  updateNumberingResolution,
  uploadCertificate,
  type RefreshableDocumentType,
} from "./admin.service.js";
import type { NumberedDocumentType } from "../documents/dianConfig.service.js";
import {
  confirmValidation,
  getNextPendingValidation,
  getValidationDetail,
  listPendingValidations,
  uploadArchivo,
  uploadRut,
} from "../firmapass/firmaPassIssuance.service.js";
import {
  createViafirmaRequest,
  getViafirmaCertificateStatus,
  getViafirmaKycLink,
  getViafirmaProfileTerms,
  listViafirmaCertificates,
  listViafirmaDocuments,
  revokeViafirmaCertificate,
  uploadViafirmaDocument,
} from "../viafirma/viafirmaIssuance.service.js";

/**
 * Tenant provisioning for Ohnix (or any other future caller acting as
 * "software propio" administrator) — gated by requireAdminApiKey, registered
 * in src/index.ts. Not for customer/end-user use.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/admin/companies", async (request, reply) => {
    const body = CreateCompanyBodySchema.parse(request.body);
    const company = await createCompany(body);
    return reply.code(201).send(company);
  });

  app.put<{ Params: { id: string } }>("/api/v1/admin/companies/:id/dian-configuration", async (request, reply) => {
    const body = SetDianConfigurationBodySchema.parse(request.body);
    const config = await setDianConfiguration({ companyId: request.params.id, ...body });
    return reply.send(config);
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/companies/:id/numbering-resolutions",
    async (request, reply) => {
      const body = CreateNumberingResolutionBodySchema.parse(request.body);
      const numbering = await createNumberingResolution({ companyId: request.params.id, ...body });
      return reply.code(201).send(numbering);
    },
  );

  // Correction-only - see updateNumberingResolution's own comment for why
  // this rejects a resolution that already has documents issued against it.
  app.patch<{ Params: { id: string; resolutionId: string } }>(
    "/api/v1/admin/companies/:id/numbering-resolutions/:resolutionId",
    async (request, reply) => {
      const body = UpdateNumberingResolutionBodySchema.parse(request.body);
      const numbering = await updateNumberingResolution({
        companyId: request.params.id,
        resolutionId: request.params.resolutionId,
        ...body,
      });
      return reply.send(numbering);
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/admin/companies/:id/certificates", async (request, reply) => {
    const body = UploadCertificateBodySchema.parse(request.body);
    const certificate = await uploadCertificate({ companyId: request.params.id, ...body });
    return reply.code(201).send(certificate);
  });

  app.post<{ Params: { id: string } }>("/api/v1/admin/companies/:id/api-keys", async (request, reply) => {
    const body = CreateApiKeyBodySchema.parse(request.body);
    const { rawKey } = await createApiKeyForCompany({ companyId: request.params.id, label: body.label });
    return reply.code(201).send({ rawKey });
  });

  // FirmaPass digital-certificate issuance (see modules/firmapass/firmaPassIssuance.service.ts).
  // Automates from "an identity validation already exists in FirmaPass's own
  // portal" onward — creating that validation itself is not automated (no
  // such endpoint exists in FirmaPass's API). A validation is created the
  // moment a client buys a certificate on FirmaPass's own site with
  // iTCycle's coupon, auto-attached to iTCycle's alliance account - the
  // three read routes below (alliance-wide, not scoped to a companyId) are
  // how an Ohnix admin discovers and matches that validation to a company
  // BEFORE driving rut/archivos/confirmar for it.
  app.get<{ Querystring: { perPage?: string; orderNumber?: string } }>(
    "/api/v1/admin/firmapass/validations",
    async (request, reply) => {
      const { perPage, orderNumber } = request.query;
      const result = await listPendingValidations({
        perPage: perPage ? Number(perPage) : undefined,
        orderNumber: orderNumber || undefined,
      });
      return reply.send(result);
    },
  );

  // 204 (not 200 + null body) when the queue is empty - lets Ohnix's admin
  // UI tell "nothing pending" apart from a real request/parsing failure.
  app.get("/api/v1/admin/firmapass/validations/nueva-solicitud", async (_request, reply) => {
    const result = await getNextPendingValidation();
    if (!result) return reply.code(204).send();
    return reply.send(result);
  });

  app.get<{ Params: { uuid: string } }>(
    "/api/v1/admin/firmapass/validations/:uuid",
    async (request, reply) => {
      const result = await getValidationDetail(request.params.uuid);
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string; uuid: string } }>(
    "/api/v1/admin/companies/:id/firmapass/validations/:uuid/rut",
    async (request, reply) => {
      const body = FirmaPassUploadRutBodySchema.parse(request.body);
      const result = await uploadRut({
        companyId: request.params.id,
        validationUuid: request.params.uuid,
        rutBase64: body.rutBase64,
        identificacionRepresentanteLegal: body.identificacionRepresentanteLegal,
      });
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string; uuid: string } }>(
    "/api/v1/admin/companies/:id/firmapass/validations/:uuid/archivos",
    async (request, reply) => {
      const body = FirmaPassUploadArchivoBodySchema.parse(request.body);
      const result = await uploadArchivo({
        companyId: request.params.id,
        validationUuid: request.params.uuid,
        type: body.type,
        fileBase64: body.fileBase64,
      });
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string; uuid: string } }>(
    "/api/v1/admin/companies/:id/firmapass/validations/:uuid/confirmar",
    async (request, reply) => {
      const result = await confirmValidation({ companyId: request.params.id, validationUuid: request.params.uuid });
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/admin/companies/:id/firmapass/status", async (request, reply) => {
    const status = await getFirmaPassStatus(request.params.id);
    return reply.send(status);
  });

  // Viafirma digital-certificate issuance (see modules/viafirma/viafirmaIssuance.service.ts).
  // Unlike FirmaPass, this starts from nothing (no pre-existing validation
  // to discover) — the CSR/keypair are generated server-side by
  // createViafirmaRequest itself.

  // Not actually company-specific (terms are RA-wide, per profile kind) -
  // scoped under :id anyway to match every other Viafirma route here, since
  // the caller (Ohnix) always has a companyId on hand at this point.
  app.get<{ Params: { id: string }; Querystring: { profileKind: "FE-PJ" | "FE-PN" } }>(
    "/api/v1/admin/companies/:id/viafirma/terms",
    async (request, reply) => {
      const result = await getViafirmaProfileTerms(request.query.profileKind);
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/admin/companies/:id/viafirma/requests", async (request, reply) => {
    const body = CreateViafirmaRequestBodySchema.parse(request.body);
    const result = await createViafirmaRequest({ companyId: request.params.id, ...body });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>("/api/v1/admin/companies/:id/viafirma/certificates", async (request, reply) => {
    const result = await listViafirmaCertificates(request.params.id);
    return reply.send(result);
  });

  app.get<{ Params: { id: string; certificateId: string } }>(
    "/api/v1/admin/companies/:id/viafirma/certificates/:certificateId/status",
    async (request, reply) => {
      const status = await getViafirmaCertificateStatus({
        companyId: request.params.id,
        certificateId: request.params.certificateId,
      });
      return reply.send(status);
    },
  );

  // Valid only while status === "accreditation" (§2.3.8) — Viafirma itself
  // returns 400 link_not_generated otherwise; propagated as-is.
  app.get<{ Params: { id: string; certificateId: string } }>(
    "/api/v1/admin/companies/:id/viafirma/certificates/:certificateId/kyc-link",
    async (request, reply) => {
      const link = await getViafirmaKycLink({ companyId: request.params.id, certificateId: request.params.certificateId });
      return reply.send({ link });
    },
  );

  app.post<{ Params: { id: string; certificateId: string } }>(
    "/api/v1/admin/companies/:id/viafirma/certificates/:certificateId/documents",
    async (request, reply) => {
      const body = ViafirmaUploadDocumentBodySchema.parse(request.body);
      const result = await uploadViafirmaDocument({
        companyId: request.params.id,
        certificateId: request.params.certificateId,
        name: body.name,
        base64: body.base64,
      });
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string; certificateId: string } }>(
    "/api/v1/admin/companies/:id/viafirma/certificates/:certificateId/documents",
    async (request, reply) => {
      const result = await listViafirmaDocuments({ companyId: request.params.id, certificateId: request.params.certificateId });
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string; certificateId: string } }>(
    "/api/v1/admin/companies/:id/viafirma/certificates/:certificateId/revoke",
    async (request, reply) => {
      const body = ViafirmaRevokeBodySchema.parse(request.body);
      const result = await revokeViafirmaCertificate({
        companyId: request.params.id,
        certificateId: request.params.certificateId,
        reason: body.reason,
      });
      return reply.send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/admin/companies/:id/dian-readiness", async (request, reply) => {
    const readiness = await getDianReadiness(request.params.id);
    return reply.code(200).send(readiness);
  });

  // Which certificate provider signs this company's real documents - a
  // selector only makes sense in Ohnix's UI when the GET below reports more
  // than one entry in activeProviders (see admin.service.ts).
  app.get<{ Params: { id: string } }>("/api/v1/admin/companies/:id/certificate-provider", async (request, reply) => {
    const status = await getCertificateProviderStatus(request.params.id);
    return reply.code(200).send(status);
  });

  app.put<{ Params: { id: string } }>("/api/v1/admin/companies/:id/certificate-provider", async (request, reply) => {
    const body = SetCertificateProviderOverrideBodySchema.parse(request.body);
    const status = await setCertificateProviderOverride(request.params.id, body.provider);
    return reply.code(200).send(status);
  });

  // Resolves the real DIAN verdict for a document an async send (SendBillAsync/
  // SendTestSetAsync) left in the intermediate "SENT" status - see
  // documentSend.service.ts's computeSentStatusFields and
  // admin.service.ts's refreshDocumentStatus. Safe to call repeatedly:
  // already-terminal documents are returned unchanged without a DIAN call.
  const REFRESHABLE_TYPES: RefreshableDocumentType[] = ["01", "91", "92"];
  app.post<{ Params: { id: string; documentType: string; docId: string } }>(
    "/api/v1/admin/companies/:id/documents/:documentType/:docId/refresh-status",
    async (request, reply) => {
      const { documentType } = request.params;
      if (!REFRESHABLE_TYPES.includes(documentType as RefreshableDocumentType)) {
        return reply.code(400).send({ error: "invalid_document_type", message: `documentType must be one of ${REFRESHABLE_TYPES.join(", ")}` });
      }
      try {
        const record = await refreshDocumentStatus({
          companyId: request.params.id,
          documentType: documentType as RefreshableDocumentType,
          id: request.params.docId,
        });
        return reply.send(record);
      } catch (error) {
        request.log.error(error);
        return reply.code(502).send({ error: "dian_status_refresh_failed", message: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // The raw DIAN SOAP response actually stored for a document (see
  // admin.service.ts's getDianRawResponse) - the only way to see why DIAN
  // rejected something when statusDescription/errorMessage came back empty.
  const RAW_RESPONSE_TYPES: NumberedDocumentType[] = ["01", "91", "92", "05"];
  app.get<{ Params: { id: string; documentType: string; docId: string } }>(
    "/api/v1/admin/companies/:id/documents/:documentType/:docId/raw-response",
    async (request, reply) => {
      const { documentType } = request.params;
      if (!RAW_RESPONSE_TYPES.includes(documentType as NumberedDocumentType)) {
        return reply.code(400).send({ error: "invalid_document_type", message: `documentType must be one of ${RAW_RESPONSE_TYPES.join(", ")}` });
      }
      try {
        const rawResponse = await getDianRawResponse({
          companyId: request.params.id,
          documentType: documentType as NumberedDocumentType,
          id: request.params.docId,
        });
        return reply.type("application/xml").send(rawResponse);
      } catch (error) {
        request.log.error(error);
        return reply.code(404).send({ error: "raw_response_not_found", message: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // Everything sent under a DIAN habilitación round (or, with no
  // ?testSetId, everything ever sent under any round) - see
  // admin.service.ts's listTestSubmissions for why this doesn't hardcode
  // DIAN's own required-scenarios checklist.
  app.get<{ Params: { id: string }; Querystring: { testSetId?: string } }>(
    "/api/v1/admin/companies/:id/test-submissions",
    async (request, reply) => {
      const submissions = await listTestSubmissions(request.params.id, request.query.testSetId || undefined);
      return reply.send({ data: submissions });
    },
  );
}
