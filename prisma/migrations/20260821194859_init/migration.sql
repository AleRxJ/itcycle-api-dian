-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DianEnvironment" AS ENUM ('PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'ACCEPTED', 'REJECTED', 'ERROR', 'CONTINGENCY');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "dv" TEXT NOT NULL,
    "personType" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DianConfiguration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "environment" "DianEnvironment" NOT NULL,
    "softwareId" TEXT NOT NULL,
    "softwarePin" TEXT NOT NULL,
    "technicalKey" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DianConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberingResolution" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "resolutionNumber" TEXT NOT NULL,
    "startNumber" INTEGER NOT NULL,
    "endNumber" INTEGER NOT NULL,
    "currentNumber" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberingResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "certificateIdentifier" TEXT NOT NULL,
    "secretReference" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "numberingId" TEXT,
    "certificateId" TEXT,
    "internalReference" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "prefix" TEXT,
    "cufe" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
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

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_nit_dv_key" ON "Company"("nit", "dv");

-- CreateIndex
CREATE UNIQUE INDEX "DianConfiguration_companyId_key" ON "DianConfiguration"("companyId");

-- CreateIndex
CREATE INDEX "NumberingResolution_companyId_idx" ON "NumberingResolution"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "NumberingResolution_companyId_prefix_key" ON "NumberingResolution"("companyId", "prefix");

-- CreateIndex
CREATE INDEX "Certificate_companyId_idx" ON "Certificate"("companyId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_status_idx" ON "Invoice"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_internalReference_key" ON "Invoice"("companyId", "internalReference");

-- AddForeignKey
ALTER TABLE "DianConfiguration" ADD CONSTRAINT "DianConfiguration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberingResolution" ADD CONSTRAINT "NumberingResolution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_numberingId_fkey" FOREIGN KEY ("numberingId") REFERENCES "NumberingResolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
