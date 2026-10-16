-- AlterTable
ALTER TABLE "incident" ADD COLUMN     "primaryCause" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "incident_event" ADD COLUMN     "data" JSONB;

-- CreateIndex
CREATE INDEX "incident_service_status_idx" ON "incident"("service", "status");

