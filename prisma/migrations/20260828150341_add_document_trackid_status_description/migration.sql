-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "statusDescription" TEXT,
ADD COLUMN     "trackId" TEXT;

-- AlterTable
ALTER TABLE "DebitNote" ADD COLUMN     "statusDescription" TEXT,
ADD COLUMN     "trackId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "statusDescription" TEXT,
ADD COLUMN     "trackId" TEXT;
