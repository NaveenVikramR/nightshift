-- DropForeignKey
ALTER TABLE "finding" DROP CONSTRAINT "finding_scanId_fkey";

-- AlterTable
ALTER TABLE "security_scan" ADD COLUMN     "checks" JSONB,
ADD COLUMN     "counts" JSONB,
ADD COLUMN     "deltas" JSONB,
ADD COLUMN     "previousScanId" TEXT,
ADD COLUMN     "startedBy" TEXT NOT NULL DEFAULT '';

-- DropTable
DROP TABLE "finding";

-- CreateTable
CREATE TABLE "security_finding" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenScanId" TEXT NOT NULL,
    "lastSeenScanId" TEXT NOT NULL,
    "resolvedScanId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "security_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "security_finding_fingerprint_key" ON "security_finding"("fingerprint");

-- CreateIndex
CREATE INDEX "security_finding_status_severity_idx" ON "security_finding"("status", "severity");

