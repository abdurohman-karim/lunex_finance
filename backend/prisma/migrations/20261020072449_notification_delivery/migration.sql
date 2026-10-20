-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'skipped');

-- DropIndex
DROP INDEX "notifications_sent_at_scheduled_at_idx";

-- AlterTable: rows from before (none are expected) count as sent and expire a day later.
ALTER TABLE "notifications" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "skip_reason" VARCHAR(32),
ADD COLUMN     "status" "notification_status" NOT NULL DEFAULT 'pending';
UPDATE "notifications" SET "expires_at" = "scheduled_at" + interval '1 day',
  "status" = CASE WHEN "sent_at" IS NULL THEN 'skipped'::"notification_status" ELSE 'sent'::"notification_status" END,
  "skip_reason" = CASE WHEN "sent_at" IS NULL THEN 'expired' END;
ALTER TABLE "notifications" ALTER COLUMN "expires_at" SET NOT NULL;

-- CreateIndex
CREATE INDEX "notifications_status_scheduled_at_idx" ON "notifications"("status", "scheduled_at");
