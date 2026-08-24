-- Backfills the migration history for schema changes that were applied
-- directly to the dev database via `prisma db push` (SupportDocument,
-- FirmaPass login key storage) instead of `prisma migrate dev`, leaving no
-- migration file behind. Content verified against the live dev schema via
-- `prisma migrate diff` — see docs/dian/compatibility.md.

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "firmaPassLoginKeyCiphertext" TEXT;

-- AlterTable
ALTER TABLE "Certificate" ALTER COLUMN "expiresAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SupportDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "numberingId" TEXT,
    "certificateId" TEXT,
    "internalReference" TEXT NOT NULL,
    "documentNumber" TEXT,
    "prefix" TEXT,
    "cufe" TEXT,
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

    CONSTRAINT "SupportDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportDocument_companyId_status_idx" ON "SupportDocument"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupportDocument_companyId_internalReference_key" ON "SupportDocument"("companyId", "internalReference");

-- AddForeignKey
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_numberingId_fkey" FOREIGN KEY ("numberingId") REFERENCES "NumberingResolution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
