-- AlterTable
ALTER TABLE "exchange_rates" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "exchange_rates_updated_at_idx" ON "exchange_rates"("updated_at");
