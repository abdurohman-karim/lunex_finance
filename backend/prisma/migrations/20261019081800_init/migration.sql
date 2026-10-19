-- CreateEnum
CREATE TYPE "language_code" AS ENUM ('uz', 'ru', 'en');

-- CreateEnum
CREATE TYPE "category_type" AS ENUM ('income', 'expense');

-- CreateEnum
CREATE TYPE "auth_provider" AS ENUM ('apple', 'google', 'telegram', 'email');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "onboarding_focus" AS ENUM ('save', 'track', 'budget');

-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('ios', 'ipados', 'watchos');

-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('cash', 'card', 'bank', 'savings', 'other');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('income', 'expense', 'transfer');

-- CreateEnum
CREATE TYPE "transaction_source" AS ENUM ('quick_add', 'voice', 'text_ai', 'receipt_scan', 'recurring', 'siri', 'widget');

-- CreateEnum
CREATE TYPE "ocr_status" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('daily', 'weekly', 'monthly', 'yearly');

-- CreateEnum
CREATE TYPE "goal_status" AS ENUM ('active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "contribution_type" AS ENUM ('deposit', 'withdrawal');

-- CreateEnum
CREATE TYPE "contribution_method" AS ENUM ('manual', 'smart_save', 'auto_save', 'round_up');

-- CreateEnum
CREATE TYPE "auto_save_rule_type" AS ENUM ('fixed_schedule', 'percent_of_income', 'round_up');

-- CreateEnum
CREATE TYPE "suggestion_status" AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "insight_kind" AS ENUM ('daily_tip', 'weekly_report', 'monthly_report', 'spending_analysis', 'goal_analysis', 'anomaly', 'budget_forecast');

-- CreateEnum
CREATE TYPE "ai_message_role" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('daily_reminder', 'budget_threshold', 'budget_exceeded', 'goal_milestone', 'goal_deadline', 'recurring_due', 'smart_save', 'auto_save_done', 'weekly_report', 'insight');

-- CreateEnum
CREATE TYPE "subscription_source" AS ENUM ('trial', 'app_store', 'promo');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'grace_period', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "ai_feature" AS ENUM ('assistant', 'parse_input', 'receipt', 'insight');

-- CreateTable
CREATE TABLE "currencies" (
    "id" SERIAL NOT NULL,
    "code" CHAR(3) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "symbol" VARCHAR(8) NOT NULL,
    "decimals" SMALLINT NOT NULL DEFAULT 2,
    "rounding_step" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "min_smart_save" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" BIGSERIAL NOT NULL,
    "base_currency_id" INTEGER NOT NULL,
    "quote_currency_id" INTEGER NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "rate_date" DATE NOT NULL,
    "source" VARCHAR(32) NOT NULL DEFAULT 'cbu',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(128),
    "email" VARCHAR(255),
    "email_verified_at" TIMESTAMP(3),
    "role" "user_role" NOT NULL DEFAULT 'user',
    "avatar_key" VARCHAR(255),
    "language" "language_code" NOT NULL DEFAULT 'uz',
    "base_currency_id" INTEGER NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tashkent',
    "onboarding_focus" "onboarding_focus",
    "monthly_income_estimate" DECIMAL(18,2),
    "onboarding_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "auth_provider" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "device_platform" NOT NULL DEFAULT 'ios',
    "model" VARCHAR(64),
    "os_version" VARCHAR(32),
    "app_version" VARCHAR(32),
    "apns_token" VARCHAR(255),
    "push_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_sync_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "biometric_lock_enabled" BOOLEAN NOT NULL DEFAULT false,
    "lock_after_seconds" INTEGER NOT NULL DEFAULT 60,
    "hide_amounts" BOOLEAN NOT NULL DEFAULT false,
    "week_starts_on" SMALLINT NOT NULL DEFAULT 1,
    "month_starts_on_day" SMALLINT NOT NULL DEFAULT 1,
    "default_account_id" UUID,
    "daily_reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
    "daily_reminder_time" TIME NOT NULL DEFAULT '21:00:00'::time,
    "budget_alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "goal_alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "recurring_alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "smart_save_enabled" BOOLEAN NOT NULL DEFAULT true,
    "weekly_report_enabled" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" TIME NOT NULL DEFAULT '22:00:00'::time,
    "quiet_hours_end" TIME NOT NULL DEFAULT '08:00:00'::time,
    "haptics_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "type" "account_type" NOT NULL DEFAULT 'cash',
    "currency_id" INTEGER NOT NULL,
    "initial_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "current_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "icon" VARCHAR(64),
    "color" CHAR(7),
    "include_in_total" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "parent_id" UUID,
    "type" "category_type" NOT NULL,
    "key" VARCHAR(32),
    "name" VARCHAR(64),
    "icon" VARCHAR(64) NOT NULL,
    "color" CHAR(7) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_translations" (
    "category_id" UUID NOT NULL,
    "language" "language_code" NOT NULL,
    "label" VARCHAR(64) NOT NULL,

    CONSTRAINT "category_translations_pkey" PRIMARY KEY ("category_id","language")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "transaction_type" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency_id" INTEGER NOT NULL,
    "amount_base" DECIMAL(18,2) NOT NULL,
    "fx_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "category_id" UUID,
    "transfer_account_id" UUID,
    "transfer_amount" DECIMAL(18,2),
    "note" VARCHAR(255),
    "merchant" VARCHAR(128),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source" "transaction_source" NOT NULL DEFAULT 'quick_add',
    "recurring_rule_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_attachments" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "ocr_status" "ocr_status" NOT NULL DEFAULT 'pending',
    "ocr_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_rules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "category_id" UUID,
    "type" "category_type" NOT NULL,
    "title" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency_id" INTEGER NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "interval" SMALLINT NOT NULL DEFAULT 1,
    "day_of_month" SMALLINT,
    "weekday" SMALLINT,
    "start_on" DATE NOT NULL,
    "end_on" DATE,
    "next_run_on" DATE NOT NULL,
    "auto_create" BOOLEAN NOT NULL DEFAULT false,
    "remind_days_before" SMALLINT NOT NULL DEFAULT 1,
    "is_subscription" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "recurring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "currency_id" INTEGER NOT NULL,
    "planned_income" DECIMAL(18,2),
    "total_limit" DECIMAL(18,2),
    "savings_target" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rollover_enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollover_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_category_limits" (
    "id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "limit_amount" DECIMAL(18,2) NOT NULL,
    "alert_threshold_pct" SMALLINT NOT NULL DEFAULT 80,

    CONSTRAINT "budget_category_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "emoji" VARCHAR(8) NOT NULL DEFAULT '🎯',
    "color" CHAR(7) NOT NULL,
    "cover_image_key" VARCHAR(255),
    "template_key" VARCHAR(32),
    "target_amount" DECIMAL(18,2) NOT NULL,
    "saved_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency_id" INTEGER NOT NULL,
    "deadline" DATE,
    "status" "goal_status" NOT NULL DEFAULT 'active',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "linked_account_id" UUID,
    "completed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_contributions" (
    "id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "contribution_type" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency_id" INTEGER NOT NULL,
    "source_amount" DECIMAL(18,2),
    "source_account_id" UUID,
    "method" "contribution_method" NOT NULL,
    "auto_save_rule_id" UUID,
    "smart_save_suggestion_id" UUID,
    "note" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "goal_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_milestones" (
    "goal_id" UUID NOT NULL,
    "percent" SMALLINT NOT NULL,
    "reached_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goal_milestones_pkey" PRIMARY KEY ("goal_id","percent")
);

-- CreateTable
CREATE TABLE "auto_save_rules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "type" "auto_save_rule_type" NOT NULL,
    "amount" DECIMAL(18,2),
    "percent" DECIMAL(5,2),
    "round_to" DECIMAL(18,2),
    "frequency" "recurrence_frequency",
    "weekday" SMALLINT,
    "day_of_month" SMALLINT,
    "source_account_id" UUID NOT NULL,
    "next_run_on" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "auto_save_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_save_suggestions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "for_date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "amount_base" DECIMAL(18,2) NOT NULL,
    "accepted_amount" DECIMAL(18,2),
    "currency_id" INTEGER NOT NULL,
    "safe_to_spend_today" DECIMAL(18,2) NOT NULL,
    "calculation" JSONB NOT NULL,
    "status" "suggestion_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smart_save_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "insight_kind" NOT NULL,
    "goal_id" UUID,
    "transaction_id" UUID,
    "period_start" DATE,
    "period_end" DATE,
    "language" "language_code" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "summary" TEXT,
    "recommendation" TEXT,
    "score" SMALLINT,
    "payload" JSONB,
    "model" VARCHAR(64),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "ai_message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "actions" JSONB,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(512) NOT NULL,
    "payload" JSONB,
    "dedupe_key" VARCHAR(128) NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" "subscription_source" NOT NULL,
    "product_id" VARCHAR(64),
    "status" "subscription_status" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "original_transaction_id" VARCHAR(64),
    "environment" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_events" (
    "id" UUID NOT NULL,
    "notification_uuid" VARCHAR(64) NOT NULL,
    "notification_type" VARCHAR(64) NOT NULL,
    "subtype" VARCHAR(64),
    "original_transaction_id" VARCHAR(64),
    "subscription_id" UUID,
    "signed_payload" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_daily" (
    "user_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "feature" "ai_feature" NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY ("user_id","usage_date","feature")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(255),
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target" VARCHAR(128),
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_currency_id_quote_currency_id_rate_date_key" ON "exchange_rates"("base_currency_id", "quote_currency_id", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");

-- CreateIndex
CREATE INDEX "email_verifications_email_created_at_idx" ON "email_verifications"("email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_apns_token_key" ON "devices"("apns_token");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "accounts_user_id_updated_at_idx" ON "accounts"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "categories_user_id_type_idx" ON "categories"("user_id", "type");

-- CreateIndex
CREATE INDEX "categories_type_key_idx" ON "categories"("type", "key");

-- CreateIndex
CREATE INDEX "transactions_user_id_occurred_at_idx" ON "transactions"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "transactions_user_id_type_occurred_at_idx" ON "transactions"("user_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "transactions_user_id_category_id_occurred_at_idx" ON "transactions"("user_id", "category_id", "occurred_at");

-- CreateIndex
CREATE INDEX "transactions_user_id_updated_at_idx" ON "transactions"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "recurring_rules_is_active_next_run_on_idx" ON "recurring_rules"("is_active", "next_run_on");

-- CreateIndex
CREATE INDEX "recurring_rules_user_id_updated_at_idx" ON "recurring_rules"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_user_id_period_start_key" ON "budgets"("user_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "budget_category_limits_budget_id_category_id_key" ON "budget_category_limits"("budget_id", "category_id");

-- CreateIndex
CREATE INDEX "goals_user_id_status_priority_idx" ON "goals"("user_id", "status", "priority");

-- CreateIndex
CREATE INDEX "goals_user_id_updated_at_idx" ON "goals"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "goal_contributions_smart_save_suggestion_id_key" ON "goal_contributions"("smart_save_suggestion_id");

-- CreateIndex
CREATE INDEX "goal_contributions_goal_id_created_at_idx" ON "goal_contributions"("goal_id", "created_at");

-- CreateIndex
CREATE INDEX "goal_contributions_user_id_created_at_idx" ON "goal_contributions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "smart_save_suggestions_user_id_for_date_idx" ON "smart_save_suggestions"("user_id", "for_date");

-- CreateIndex
CREATE INDEX "ai_insights_user_id_kind_created_at_idx" ON "ai_insights"("user_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_sent_at_scheduled_at_idx" ON "notifications"("sent_at", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_original_transaction_id_key" ON "subscriptions"("original_transaction_id");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_expires_at_idx" ON "subscriptions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_events_notification_uuid_key" ON "store_events"("notification_uuid");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_base_currency_id_fkey" FOREIGN KEY ("base_currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_quote_currency_id_fkey" FOREIGN KEY ("quote_currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_base_currency_id_fkey" FOREIGN KEY ("base_currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_account_id_fkey" FOREIGN KEY ("default_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_translations" ADD CONSTRAINT "category_translations_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_account_id_fkey" FOREIGN KEY ("transfer_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_rule_id_fkey" FOREIGN KEY ("recurring_rule_id") REFERENCES "recurring_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_category_limits" ADD CONSTRAINT "budget_category_limits_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_category_limits" ADD CONSTRAINT "budget_category_limits_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_linked_account_id_fkey" FOREIGN KEY ("linked_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_auto_save_rule_id_fkey" FOREIGN KEY ("auto_save_rule_id") REFERENCES "auto_save_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_smart_save_suggestion_id_fkey" FOREIGN KEY ("smart_save_suggestion_id") REFERENCES "smart_save_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_milestones" ADD CONSTRAINT "goal_milestones_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_save_rules" ADD CONSTRAINT "auto_save_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_save_rules" ADD CONSTRAINT "auto_save_rules_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_save_rules" ADD CONSTRAINT "auto_save_rules_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_save_suggestions" ADD CONSTRAINT "smart_save_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_save_suggestions" ADD CONSTRAINT "smart_save_suggestions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_save_suggestions" ADD CONSTRAINT "smart_save_suggestions_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_events" ADD CONSTRAINT "store_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
