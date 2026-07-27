CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`diff_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_created_idx` ON `admin_audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_entity_idx` ON `admin_audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'staff' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_unique` ON `admin_users` (`email`);--> statement-breakpoint
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
CREATE INDEX `appointments_phone_created_at_idx` ON `appointments` (`phone`,`created_at`);--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`quoted_unit_price_paise` integer,
	`quoted_at` text,
	`added_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cart_items_quantity_positive_ck" CHECK(quantity > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_variant_idx` ON `cart_items` (`cart_id`,`variant_id`);--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `carts_status_updated_idx` ON `carts` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'category' NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_visible` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_slug_unique` ON `collections` (`slug`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text,
	`email` text,
	`name` text,
	`consent_version` text,
	`consent_at` text,
	`marketing_opt_in` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletion_requested_at` text,
	`purge_not_before_at` text,
	`redacted_at` text,
	CONSTRAINT "customers_deletion_request_pairs_ck" CHECK((deletion_requested_at IS NULL AND purge_not_before_at IS NULL)
        OR (deletion_requested_at IS NOT NULL AND purge_not_before_at IS NOT NULL)),
	CONSTRAINT "customers_retention_floor_ck" CHECK(redacted_at IS NULL
        OR (purge_not_before_at IS NOT NULL AND redacted_at >= purge_not_before_at)),
	CONSTRAINT "customers_live_row_has_phone_ck" CHECK(redacted_at IS NOT NULL OR phone IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_email_idx` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX `customers_deletion_requested_idx` ON `customers` (`deletion_requested_at`);--> statement-breakpoint
CREATE TABLE `gold_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`metal` text NOT NULL,
	`fineness` integer NOT NULL,
	`rate_per_ten_grams_paise` integer NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`source_quote_raw` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "gold_rates_rate_positive_ck" CHECK(rate_per_ten_grams_paise > 0),
	CONSTRAINT "gold_rates_fineness_range_ck" CHECK(fineness > 0 AND fineness <= 1000)
);
--> statement-breakpoint
CREATE INDEX `gold_rates_lookup_idx` ON `gold_rates` (`metal`,`fineness`,`effective_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `gold_rates_current_idx` ON `gold_rates` (`metal`,`fineness`) WHERE effective_to IS NULL;--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`sku` text NOT NULL,
	`title_snapshot` text NOT NULL,
	`variant_description_snapshot` text,
	`image_r2_key_snapshot` text,
	`metal_snapshot` text,
	`fineness_snapshot` integer,
	`purity_carat_label_snapshot` text,
	`net_metal_weight_mg` integer,
	`gross_weight_mg` integer,
	`gold_rate_id` text,
	`gold_rate_per_ten_grams_paise` integer,
	`gold_rate_effective_from` text,
	`gold_rate_captured_at` text,
	`metal_value_paise` integer DEFAULT 0 NOT NULL,
	`making_charge_type` text,
	`making_charge_value` integer,
	`making_charge_paise` integer DEFAULT 0 NOT NULL,
	`stone_value_paise` integer DEFAULT 0 NOT NULL,
	`hallmarking_paise` integer DEFAULT 0 NOT NULL,
	`other_charges_paise` integer DEFAULT 0 NOT NULL,
	`huid_snapshot` text,
	`certificate_number_snapshot` text,
	`certificate_lab_snapshot` text,
	`diamond_origin_snapshot` text,
	`country_of_origin_snapshot` text,
	`hsn_code` text DEFAULT '7113' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`line_discount_paise` integer DEFAULT 0 NOT NULL,
	`line_subtotal_paise` integer NOT NULL,
	`line_gst_rate_bps` integer DEFAULT 300 NOT NULL,
	`line_gst_paise` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gold_rate_id`) REFERENCES `gold_rates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_quantity_positive_ck" CHECK(quantity > 0),
	CONSTRAINT "order_items_unit_price_foots_ck" CHECK(unit_price_paise = metal_value_paise + making_charge_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise),
	CONSTRAINT "order_items_subtotal_foots_ck" CHECK(line_subtotal_paise = unit_price_paise * quantity - line_discount_paise),
	CONSTRAINT "order_items_total_foots_ck" CHECK(line_total_paise = line_subtotal_paise + line_gst_paise)
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` text NOT NULL,
	`customer_id` text,
	`quote_id` text,
	`contact_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`contact_email` text,
	`ship_name` text,
	`ship_line1` text,
	`ship_line2` text,
	`ship_city` text,
	`ship_state` text,
	`ship_pincode` text,
	`ship_country` text DEFAULT 'IN' NOT NULL,
	`billing_same_as_shipping` integer DEFAULT true NOT NULL,
	`billing_json` text,
	`customer_gstin` text,
	`customer_pan` text,
	`metal_value_paise` integer NOT NULL,
	`making_charges_paise` integer NOT NULL,
	`stone_value_paise` integer NOT NULL,
	`hallmarking_paise` integer DEFAULT 0 NOT NULL,
	`other_charges_paise` integer DEFAULT 0 NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`shipping_paise` integer DEFAULT 0 NOT NULL,
	`taxable_paise` integer NOT NULL,
	`gst_rate_bps` integer DEFAULT 300 NOT NULL,
	`gst_paise` integer NOT NULL,
	`cgst_paise` integer DEFAULT 0 NOT NULL,
	`sgst_paise` integer DEFAULT 0 NOT NULL,
	`igst_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`place_of_supply_state_code` text,
	`payment_plan` text DEFAULT 'full_prepaid' NOT NULL,
	`fulfilment_mode` text DEFAULT 'ship' NOT NULL,
	`advance_due_paise` integer NOT NULL,
	`advance_paid_paise` integer DEFAULT 0 NOT NULL,
	`balance_due_paise` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`fulfilment_status` text DEFAULT 'unfulfilled' NOT NULL,
	`complaint_ticket_number` text,
	`line_item_count` integer NOT NULL,
	`notes` text,
	`placed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `price_quotes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_taxable_foots_ck" CHECK(taxable_paise = metal_value_paise + making_charges_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise - discount_paise + shipping_paise),
	CONSTRAINT "orders_total_foots_ck" CHECK(total_paise = taxable_paise + gst_paise),
	CONSTRAINT "orders_gst_split_foots_ck" CHECK(gst_paise = cgst_paise + sgst_paise + igst_paise),
	CONSTRAINT "orders_payment_legs_foot_ck" CHECK(advance_due_paise + balance_due_paise = total_paise),
	CONSTRAINT "orders_no_cod_ck" CHECK((payment_plan = 'full_prepaid' AND balance_due_paise = 0)
        OR (payment_plan = 'booking_advance' AND fulfilment_mode = 'store_pickup' AND balance_due_paise > 0)),
	CONSTRAINT "orders_shipping_address_ck" CHECK(fulfilment_mode <> 'ship'
        OR (ship_name IS NOT NULL AND ship_line1 IS NOT NULL AND ship_city IS NOT NULL
            AND ship_state IS NOT NULL AND ship_pincode IS NOT NULL)),
	CONSTRAINT "orders_line_item_count_ck" CHECK(line_item_count > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `orders_status_placed_idx` ON `orders` (`status`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_phone_idx` ON `orders` (`contact_phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_complaint_ticket_idx` ON `orders` (`complaint_ticket_number`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text,
	`quote_id` text,
	`provider` text NOT NULL,
	`provider_order_id` text,
	`provider_payment_id` text,
	`method` text,
	`kind` text DEFAULT 'full_payment' NOT NULL,
	`amount_paise` integer NOT NULL,
	`status` text NOT NULL,
	`raw_payload_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`quote_id`) REFERENCES `price_quotes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_positive_ck" CHECK(amount_paise > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_payment_idx` ON `payments` (`provider`,`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE TABLE `price_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`metal_value_paise` integer NOT NULL,
	`making_charges_paise` integer NOT NULL,
	`stone_value_paise` integer NOT NULL,
	`hallmarking_paise` integer DEFAULT 0 NOT NULL,
	`other_charges_paise` integer DEFAULT 0 NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`shipping_paise` integer DEFAULT 0 NOT NULL,
	`taxable_paise` integer NOT NULL,
	`gst_rate_bps` integer DEFAULT 300 NOT NULL,
	`gst_paise` integer NOT NULL,
	`total_paise` integer NOT NULL,
	`amount_due_now_paise` integer NOT NULL,
	`payment_plan` text DEFAULT 'full_prepaid' NOT NULL,
	`lines_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "price_quotes_taxable_foots_ck" CHECK(taxable_paise = metal_value_paise + making_charges_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise - discount_paise + shipping_paise),
	CONSTRAINT "price_quotes_total_foots_ck" CHECK(total_paise = taxable_paise + gst_paise),
	CONSTRAINT "price_quotes_amount_due_ck" CHECK(amount_due_now_paise > 0 AND amount_due_now_paise <= total_paise),
	CONSTRAINT "price_quotes_status_ck" CHECK(status IN ('active', 'consumed', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `price_quotes_cart_status_idx` ON `price_quotes` (`cart_id`,`status`);--> statement-breakpoint
CREATE INDEX `price_quotes_expires_idx` ON `price_quotes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `product_collections` (
	`product_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `collection_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_collections_collection_idx` ON `product_collections` (`collection_id`);--> statement-breakpoint
CREATE TABLE `product_media` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`r2_key` text NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`alt` text,
	`width` integer,
	`height` integer,
	`content_type` text NOT NULL,
	`byte_size` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `product_media_product_position_idx` ON `product_media` (`product_id`,`position`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`craft` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sale_mode` text DEFAULT 'enquire_only' NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_status_sale_mode_idx` ON `products` (`status`,`sale_mode`);--> statement-breakpoint
CREATE INDEX `products_craft_idx` ON `products` (`craft`);--> statement-breakpoint
CREATE TABLE `stock_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stock_reservations_status_ck" CHECK(status IN ('held', 'consumed', 'released')),
	CONSTRAINT "stock_reservations_quantity_positive_ck" CHECK(quantity > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_reservations_active_idx` ON `stock_reservations` (`variant_id`) WHERE status = 'held';--> statement-breakpoint
CREATE INDEX `stock_reservations_expiry_idx` ON `stock_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_number` text NOT NULL,
	`order_id` text,
	`customer_id` text,
	`contact_name` text NOT NULL,
	`contact_phone` text,
	`contact_email` text,
	`kind` text DEFAULT 'complaint' NOT NULL,
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
CREATE UNIQUE INDEX `support_tickets_ticket_number_unique` ON `support_tickets` (`ticket_number`);--> statement-breakpoint
CREATE INDEX `support_tickets_status_due_idx` ON `support_tickets` (`status`,`redress_due_at`);--> statement-breakpoint
CREATE INDEX `support_tickets_order_idx` ON `support_tickets` (`order_id`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`metal` text DEFAULT 'gold' NOT NULL,
	`fineness` integer,
	`size` text,
	`colour` text,
	`pricing_mode` text DEFAULT 'dynamic_metal' NOT NULL,
	`net_metal_weight_mg` integer,
	`gross_weight_mg` integer,
	`making_charge_type` text,
	`making_charge_value` integer,
	`stone_value_paise` integer DEFAULT 0 NOT NULL,
	`hallmarking_paise` integer DEFAULT 4500 NOT NULL,
	`other_charges_paise` integer DEFAULT 0 NOT NULL,
	`fixed_price_paise` integer,
	`huid` text,
	`hallmark_purity_mark` text,
	`certificate_number` text,
	`certificate_lab` text,
	`diamond_origin` text DEFAULT 'none' NOT NULL,
	`country_of_origin` text DEFAULT 'India' NOT NULL,
	`hsn_code` text DEFAULT '7113' NOT NULL,
	`is_unique_piece` integer DEFAULT true NOT NULL,
	`stock_quantity` integer DEFAULT 1 NOT NULL,
	`is_made_to_order` integer DEFAULT false NOT NULL,
	`lead_time_days` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "variants_pricing_inputs_ck" CHECK((pricing_mode = 'dynamic_metal' AND net_metal_weight_mg IS NOT NULL AND fineness IS NOT NULL)
        OR (pricing_mode = 'fixed' AND fixed_price_paise IS NOT NULL)
        OR (pricing_mode = 'on_request')),
	CONSTRAINT "variants_stock_non_negative_ck" CHECK(stock_quantity >= 0),
	CONSTRAINT "variants_unique_piece_stock_ck" CHECK(is_unique_piece = 0 OR stock_quantity <= 1),
	CONSTRAINT "variants_fineness_range_ck" CHECK(fineness IS NULL OR (fineness > 0 AND fineness <= 1000)),
	CONSTRAINT "variants_money_non_negative_ck" CHECK(stone_value_paise >= 0
      AND hallmarking_paise >= 0
      AND other_charges_paise >= 0
      AND (fixed_price_paise IS NULL OR fixed_price_paise >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_unique` ON `variants` (`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`);--> statement-breakpoint
CREATE INDEX `variants_stock_idx` ON `variants` (`stock_quantity`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`processed_at` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_events_received_idx` ON `webhook_events` (`received_at`);