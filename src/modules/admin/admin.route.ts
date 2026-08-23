import type { FastifyInstance } from "fastify";

import {
  CreateApiKeyBodySchema,
  CreateCompanyBodySchema,
  CreateNumberingResolutionBodySchema,
  SetDianConfigurationBodySchema,
  UploadCertificateBodySchema,
} from "./admin.schemas.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  setDianConfiguration,
  uploadCertificate,
} from "./admin.service.js";

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
}
