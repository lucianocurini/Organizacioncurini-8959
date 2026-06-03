CREATE TABLE `rebillings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`billing_start` text NOT NULL,
	`billing_end` text NOT NULL,
	`premium` real,
	`monthly_fee` real,
	`sum_insured` real,
	`notes` text,
	`created_by` integer,
	`created_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
