-- AlterTable
ALTER TABLE "NumberingResolution" ADD COLUMN     "documentType" TEXT NOT NULL DEFAULT '01';

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "numberingId" TEXT,
    "certificateId" TEXT,
    "internalReference" TEXT NOT NULL,
    "noteNumber" TEXT,
    "prefix" TEXT,
    "cufe" TEXT,
    "discrepancyResponseCode" TEXT NOT NULL,
    "discrepancyDescription" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
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

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "numberingId" TEXT,
    "certificateId" TEXT,
    "internalReference" TEXT NOT NULL,
    "noteNumber" TEXT,
    "prefix" TEXT,
    "cufe" TEXT,
    "discrepancyResponseCode" TEXT NOT NULL,
    "discrepancyDescription" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
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

    CONSTRAINT "DebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditNote_companyId_status_idx" ON "CreditNote"("companyId", "status");

-- CreateIndex
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_companyId_internalReference_key" ON "CreditNote"("companyId", "internalReference");

-- CreateIndex
CREATE INDEX "DebitNote_companyId_status_idx" ON "DebitNote"("companyId", "status");

-- CreateIndex
CREATE INDEX "DebitNote_invoiceId_idx" ON "DebitNote"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DebitNote_companyId_internalReference_key" ON "DebitNote"("companyId", "internalReference");

-- CreateIndex
CREATE INDEX "NumberingResolution_companyId_documentType_status_idx" ON "NumberingResolution"("companyId", "documentType", "status");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_numberingId_fkey" FOREIGN KEY ("numberingId") REFERENCES "NumberingResolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_numberingId_fkey" FOREIGN KEY ("numberingId") REFERENCES "NumberingResolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
