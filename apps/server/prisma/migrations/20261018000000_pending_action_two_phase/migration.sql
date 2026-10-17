-- AlterTable
ALTER TABLE "pending_action" ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "incidentId" TEXT,
ADD COLUMN     "paramsHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "service" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "summary" JSONB,
ADD COLUMN     "verification" JSONB;

-- CreateIndex
CREATE INDEX "pending_action_executedAt_idx" ON "pending_action"("executedAt");

