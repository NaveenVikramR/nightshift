-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_action" (
    "id" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "service" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_event" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_scan" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "score" INTEGER,
    "grade" TEXT,

    CONSTRAINT "security_scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_actor_createdAt_idx" ON "audit_log"("actor", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_action_confirmationId_key" ON "pending_action"("confirmationId");

-- CreateIndex
CREATE INDEX "pending_action_createdBy_usedAt_idx" ON "pending_action"("createdBy", "usedAt");

-- CreateIndex
CREATE INDEX "incident_status_openedAt_idx" ON "incident"("status", "openedAt");

-- CreateIndex
CREATE INDEX "incident_event_incidentId_createdAt_idx" ON "incident_event"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "security_scan_startedAt_idx" ON "security_scan"("startedAt");

-- CreateIndex
CREATE INDEX "finding_scanId_idx" ON "finding"("scanId");

-- AddForeignKey
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "security_scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
