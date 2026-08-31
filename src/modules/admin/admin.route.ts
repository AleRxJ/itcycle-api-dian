import type { FastifyInstance } from "fastify";

import {
  CreateApiKeyBodySchema,
  CreateCompanyBodySchema,
  CreateNumberingResolutionBodySchema,
  FirmaPassUploadArchivoBodySchema,
  FirmaPassUploadRutBodySchema,
  SetDianConfigurationBodySchema,
  UploadCertificateBodySchema,
} from "./admin.schemas.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  getDianReadiness,
  getFirmaPassStatus,
  listTestSubmissions,
  refreshDocumentStatus,
  setDianConfiguration,
  uploadCertificate,
  type RefreshableDocumentType,
} from "./admin.service.js";
import {
  confirmValidation,
  getNextPendingValidation,
  getValidationDetail,
  listPendingValidations,
  uploadArchivo,
  uploadRut,
} from "../firmapass/firmaPassIssuance.service.js";

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

  app.get<{ Params: { id: string } }>("/api/v1/admin/companies/:id/dian-readiness", async (request, reply) => {
    const readiness = await getDianReadiness(request.params.id);
    return reply.code(200).send(readiness);
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
