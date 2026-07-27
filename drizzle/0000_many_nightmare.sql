CREATE TABLE `appointments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`interest` text NOT NULL,
	`preferred_time` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`source` text DEFAULT 'website' NOT NULL,
	`user_agent` text,
	`country` text
);
--> statement-breakpoint
CREATE INDEX `appointments_created_at_idx` ON `appointments` (`created_at`);--> statement-breakpoint
CREATE INDEX `appointments_phone_created_at_idx` ON `appointments` (`phone`,`created_at`);