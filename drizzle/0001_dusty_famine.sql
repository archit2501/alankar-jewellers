PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_number` text NOT NULL,
	`order_id` text,
	`customer_id` text,
	`contact_name` text NOT NULL,
	`contact_phone` text,
	`contact_email` text,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`acknowledge_due_at` text NOT NULL,
	`acknowledged_at` text,
	`redress_due_at` text NOT NULL,
	`resolved_at` text,
	`resolution_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_support_tickets`("id", "ticket_number", "order_id", "customer_id", "contact_name", "contact_phone", "contact_email", "kind", "subject", "body", "status", "assigned_to", "acknowledge_due_at", "acknowledged_at", "redress_due_at", "resolved_at", "resolution_note", "created_at", "updated_at") SELECT "id", "ticket_number", "order_id", "customer_id", "contact_name", "contact_phone", "contact_email", "kind", "subject", "body", "status", "assigned_to", "acknowledge_due_at", "acknowledged_at", "redress_due_at", "resolved_at", "resolution_note", "created_at", "updated_at" FROM `support_tickets`;--> statement-breakpoint
DROP TABLE `support_tickets`;--> statement-breakpoint
ALTER TABLE `__new_support_tickets` RENAME TO `support_tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `support_tickets_ticket_number_unique` ON `support_tickets` (`ticket_number`);--> statement-breakpoint
CREATE INDEX `support_tickets_status_due_idx` ON `support_tickets` (`status`,`redress_due_at`);--> statement-breakpoint
CREATE INDEX `support_tickets_order_idx` ON `support_tickets` (`order_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancellation_reason_code` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancellation_note` text;