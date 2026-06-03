-- Recrear payments con policy_id nullable y columnas de imputación manual
CREATE TABLE `payments_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer,
	`manual_payer` text,
	`manual_policy_number` text,
	`manual_company` text,
	`amount` real NOT NULL,
	`payment_method` text NOT NULL,
	`payment_date` text NOT NULL,
	`period_month` text,
	`notes` text,
	`status` text NOT NULL DEFAULT 'confirmado',
	`created_by` integer,
	`created_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
INSERT INTO `payments_new` SELECT
  id, policy_id, NULL, NULL, NULL,
  amount, payment_method, payment_date, period_month, notes, status,
  created_by, created_at
FROM `payments`;
DROP TABLE `payments`;
ALTER TABLE `payments_new` RENAME TO `payments`;
