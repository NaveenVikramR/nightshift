-- CreateTable
CREATE TABLE "deploy_event" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "commitSha" TEXT,
    "commitMessage" TEXT,
    "author" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "deployedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deploy_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deploy_event_service_deployedAt_idx" ON "deploy_event"("service", "deployedAt");

-- CreateIndex
CREATE UNIQUE INDEX "deploy_event_source_externalId_key" ON "deploy_event"("source", "externalId");

