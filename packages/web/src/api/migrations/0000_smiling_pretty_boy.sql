CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cuit` text,
	`phone` text,
	`email` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `insureds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dni` text,
	`phone` text,
	`email` text,
	`address` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_number` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'activa' NOT NULL,
	`company_id` integer NOT NULL,
	`insured_id` integer NOT NULL,
	`premium` real,
	`sum_insured` real,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`notes` text,
	`vehicle_brand` text,
	`vehicle_model` text,
	`vehicle_year` integer,
	`vehicle_plate` text,
	`property_address` text,
	`business_name` text,
	`business_activity` text,
	`created_by` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`insured_id`) REFERENCES `insureds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);