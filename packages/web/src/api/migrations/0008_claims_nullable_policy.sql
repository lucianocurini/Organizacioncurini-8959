-- Recrear claims con policy_id nullable y columnas de lista previa
CREATE TABLE `claims_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer,
	`claim_number` text,
	`status` text NOT NULL DEFAULT 'pendiente',
	-- Datos manuales (cuando no hay póliza vinculada)
	`manual_insured` text,
	`manual_company` text,
	`manual_policy_number` text,
	`manual_policy_type` text,
	`manual_notes` text,
	-- Paso 2
	`incident_date` text,
	`incident_time` text,
	`incident_location` text,
	`incident_description` text,
	`damages` text,
	-- Tercero
	`third_party_name` text,
	`third_party_dni` text,
	`third_party_phone` text,
	`third_party_vehicle_plate` text,
	`third_party_vehicle_brand` text,
	`third_party_vehicle_model` text,
	`third_party_insurer` text,
	`third_party_policy_number` text,
	-- Paso 3
	`claim_filed` integer DEFAULT 0,
	`claim_filed_date` text,
	`claim_company` text,
	`claim_number_third` text,
	`claim_notes` text,
	-- Paso 4
	`resolved` integer DEFAULT 0,
	`resolved_date` text,
	`resolution_notes` text,
	`resolution_amount` real,
	`created_by` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
INSERT INTO `claims_new` SELECT
  id, policy_id, claim_number, status,
  NULL, NULL, NULL, NULL, NULL,
  incident_date, incident_time, incident_location, incident_description, damages,
  third_party_name, third_party_dni, third_party_phone,
  third_party_vehicle_plate, third_party_vehicle_brand, third_party_vehicle_model,
  third_party_insurer, third_party_policy_number,
  claim_filed, claim_filed_date, claim_company, claim_number_third, claim_notes,
  resolved, resolved_date, resolution_notes, resolution_amount,
  created_by, created_at, updated_at
FROM `claims`;
DROP TABLE `claims`;
ALTER TABLE `claims_new` RENAME TO `claims`;
