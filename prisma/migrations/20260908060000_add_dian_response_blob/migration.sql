-- CreateTable
CREATE TABLE "DianResponseBlob" (
    "reference" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DianResponseBlob_pkey" PRIMARY KEY ("reference")
);
