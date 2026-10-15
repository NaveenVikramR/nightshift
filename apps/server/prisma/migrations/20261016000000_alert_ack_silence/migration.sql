-- CreateTable
CREATE TABLE "alert_ack" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "alertname" TEXT NOT NULL,
    "service" TEXT,
    "ackedBy" TEXT NOT NULL,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_ack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_silence" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "alertname" TEXT NOT NULL,
    "silenceId" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_silence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_ack_fingerprint_startsAt_key" ON "alert_ack"("fingerprint", "startsAt");

-- CreateIndex
CREATE INDEX "alert_silence_fingerprint_createdAt_idx" ON "alert_silence"("fingerprint", "createdAt");
