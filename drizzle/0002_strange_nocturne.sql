-- HAND-CORRECTED. Read this before regenerating it.
--
-- `drizzle-kit generate` emitted this migration with the `admin_users` rebuild
-- selecting the NEW columns out of the OLD table:
--
--     INSERT INTO `__new_admin_users`(..., "password_hash", ...)
--     SELECT ..., "password_hash", ... FROM `admin_users`;
--
-- `admin_users` has no `password_hash` yet — that is the entire point of this
-- migration — so the statement fails with `no such column`, and because
-- migrations here are forward-only and applied by the control plane on deploy,
-- it would have failed in production with no way back. drizzle-kit does this
-- whenever one generation both RECREATES a table (SQLite cannot add a CHECK any
-- other way) and ADDS columns to it.
--
-- Two corrections, and nothing else:
--   1. the copy moves only the seven columns the old table actually has; the
--      new ones take their declared defaults (NULL, or 0 for the counter);
--   2. `admin_sessions` is created AFTER the rebuild, so its foreign key is
--      declared against the table that survives rather than one that is about
--      to be dropped and renamed over.
--
-- The snapshot in `drizzle/meta/0002_snapshot.json` already describes the end
-- state, so re-running `npm run db:generate` produces no diff and will not
-- overwrite this file. The CI "migrations are current" job stays green.

-- MANUAL CORRECTION 2 (see also the note above).
-- drizzle-kit emitted every CHECK constraint qualified with the TEMPORARY table
-- name: CHECK("__new_admin_users"."email" = lower("__new_admin_users"."email")).
-- The rebuild pattern then renames that table to `admin_users`, at which point
-- those references dangle and SQLite refuses the table with
--   error in table admin_users after rename: no such column: __new_admin_users.email
-- Forward-only, applied by the control plane on deploy, with no way back. The
-- qualifiers are stripped; bare column names in a CHECK always resolve to the
-- row being checked, whatever the table is called.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'staff' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`password_hash` text,
	`password_salt` text,
	`password_algo` text,
	`password_iterations` integer,
	`password_updated_at` text,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`last_login_at` text,
	CONSTRAINT "admin_users_email_lower_ck" CHECK("email" = lower("email")),
	CONSTRAINT "admin_users_role_ck" CHECK("role" in ('owner', 'manager', 'staff')),
	CONSTRAINT "admin_users_credential_complete_ck" CHECK(("password_hash" is null and "password_salt" is null and "password_algo" is null and "password_iterations" is null)
       or ("password_hash" is not null and "password_salt" is not null and "password_algo" is not null and "password_iterations" is not null and "password_iterations" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_admin_users`("id", "email", "display_name", "role", "is_active", "last_seen_at", "created_at") SELECT "id", "email", "display_name", "role", "is_active", "last_seen_at", "created_at" FROM `admin_users`;--> statement-breakpoint
DROP TABLE `admin_users`;--> statement-breakpoint
ALTER TABLE `__new_admin_users` RENAME TO `admin_users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_unique` ON `admin_users` (`email`);--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`idle_expires_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`revoked_reason` text,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "admin_sessions_window_ck" CHECK("admin_sessions"."created_at" like '____-__-__T__:__:__%Z'
       and "admin_sessions"."expires_at" > "admin_sessions"."created_at"
       and "admin_sessions"."idle_expires_at" <= "admin_sessions"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_hash_unique` ON `admin_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admin_sessions_user_idx` ON `admin_sessions` (`admin_user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `admin_sessions_expiry_idx` ON `admin_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `admin_audit_log` ADD `actor_admin_user_id` text;--> statement-breakpoint
ALTER TABLE `admin_audit_log` ADD `result` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `admin_audit_log` ADD `ip` text;--> statement-breakpoint
ALTER TABLE `admin_audit_log` ADD `user_agent` text;--> statement-breakpoint
CREATE INDEX `admin_audit_actor_idx` ON `admin_audit_log` (`actor_email`,`created_at`);
