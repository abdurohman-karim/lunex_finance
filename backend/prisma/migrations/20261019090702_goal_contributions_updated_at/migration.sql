-- AlterTable
ALTER TABLE "goal_contributions" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "goal_contributions_user_id_updated_at_idx" ON "goal_contributions"("user_id", "updated_at");
