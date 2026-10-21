-- AlterEnum
ALTER TYPE "device_platform" ADD VALUE 'web';

-- AlterTable
ALTER TABLE "ai_usage_daily" ADD COLUMN     "failed" INTEGER NOT NULL DEFAULT 0;
