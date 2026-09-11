-- CreateEnum
CREATE TYPE "ReceiptAcknowledgmentEventType" AS ENUM ('ACUSE_RECIBO', 'RECIBO_BIEN', 'ACEPTACION_EXPRESA', 'RECLAMO');

-- CreateTable
CREATE TABLE "ReceiptAcknowledgment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "certificateId" TEXT,
    "internalReference" TEXT NOT NULL,
    "eventType" "ReceiptAcknowledgmentEventType" NOT NULL,
    "referencedCufe" TEXT NOT NULL,
    "referencedInvoiceId" TEXT,
    "responseCode" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "xmlReference" TEXT,
    "dianResponseReference" TEXT,
    "issuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptAcknowledgment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReceiptAcknowledgment_companyId_internalReference_key" ON "ReceiptAcknowledgment"("companyId", "internalReference");
CREATE INDEX "ReceiptAcknowledgment_companyId_status_idx" ON "ReceiptAcknowledgment"("companyId", "status");
CREATE INDEX "ReceiptAcknowledgment_companyId_referencedCufe_idx" ON "ReceiptAcknowledgment"("companyId", "referencedCufe");

ALTER TABLE "ReceiptAcknowledgment" ADD CONSTRAINT "ReceiptAcknowledgment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptAcknowledgment" ADD CONSTRAINT "ReceiptAcknowledgment_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
