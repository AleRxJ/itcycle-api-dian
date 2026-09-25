-- Audit trail for exportCertificate (admin.service.ts) - see
-- CertificateExportEvent in schema.prisma. No secret material stored here,
-- only that an export happened, for which certificate/company, and when.
CREATE TABLE "CertificateExportEvent" (
    "id" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CertificateExportEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CertificateExportEvent_certificateId_idx" ON "CertificateExportEvent"("certificateId");

CREATE INDEX "CertificateExportEvent_companyId_idx" ON "CertificateExportEvent"("companyId");

ALTER TABLE "CertificateExportEvent" ADD CONSTRAINT "CertificateExportEvent_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
