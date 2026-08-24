import type { FastifyInstance } from "fastify";

import {
  CreateApiKeyBodySchema,
  CreateCompanyBodySchema,
  CreateNumberingResolutionBodySchema,
  FirmaPassUploadArchivoBodySchema,
  FirmaPassUploadRutBodySchema,
  SetDianConfigurationBodySchema,
  SetFirmaPassLoginKeyBodySchema,
  UploadCertificateBodySchema,
} from "./admin.schemas.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  getFirmaPassStatus,
  setDianConfiguration,
  uploadCertificate,
} from "./admin.service.js";
import {
  confirmValidation,
  setFirmaPassLoginKey,
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
  // such endpoint exists in FirmaPass's API).
  app.put<{ Params: { id: string } }>("/api/v1/admin/companies/:id/firmapass/login-key", async (request, reply) => {
    const body = SetFirmaPassLoginKeyBodySchema.parse(request.body);
    await setFirmaPassLoginKey(request.params.id, body.loginKey);
    return reply.code(204).send();
  });

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
}
