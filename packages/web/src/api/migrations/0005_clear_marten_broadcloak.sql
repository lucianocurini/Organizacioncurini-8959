CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`document_type` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pendiente' NOT NULL,
	`scheduled_date` text,
	`completed_date` text,
	`notes` text,
	`created_by` integer,
	`created_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`amount` real NOT NULL,
	`payment_method` text NOT NULL,
	`payment_date` text NOT NULL,
	`period_month` text,
	`notes` text,
	`status` text DEFAULT 'confirmado' NOT NULL,
	`created_by` integer,
	`created_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
