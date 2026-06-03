-- Recrear deliveries con policy_id nullable y columnas de registro manual
CREATE TABLE `deliveries_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer,
	`manual_recipient` text,
	`manual_policy_number` text,
	`manual_company` text,
	`document_type` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pendiente',
	`scheduled_date` text,
	`completed_date` text,
	`notes` text,
	`created_by` integer,
	`created_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
INSERT INTO `deliveries_new` SELECT
  id, policy_id, NULL, NULL, NULL,
  document_type, channel, status,
  scheduled_date, completed_date, notes,
  created_by, created_at
FROM `deliveries`;
DROP TABLE `deliveries`;
ALTER TABLE `deliveries_new` RENAME TO `deliveries`;
