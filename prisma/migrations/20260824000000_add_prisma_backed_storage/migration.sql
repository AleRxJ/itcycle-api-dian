-- CreateTable
CREATE TABLE "CertificateSecretBlob" (
    "reference" TEXT NOT NULL,
    "p12Ciphertext" BYTEA NOT NULL,
    "passwordCiphertext" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateSecretBlob_pkey" PRIMARY KEY ("reference")
);

-- CreateTable
CREATE TABLE "DocumentXmlBlob" (
    "reference" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentXmlBlob_pkey" PRIMARY KEY ("reference")
);
