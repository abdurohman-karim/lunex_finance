-- AlterTable
ALTER TABLE "user_settings" ALTER COLUMN "daily_reminder_time" SET DEFAULT '21:00:00'::time,
ALTER COLUMN "quiet_hours_start" SET DEFAULT '22:00:00'::time,
ALTER COLUMN "quiet_hours_end" SET DEFAULT '08:00:00'::time;

-- CreateTable
CREATE TABLE "category_preferences" (
    "user_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_preferences_pkey" PRIMARY KEY ("user_id","category_id")
);

-- AddForeignKey
ALTER TABLE "category_preferences" ADD CONSTRAINT "category_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_preferences" ADD CONSTRAINT "category_preferences_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
