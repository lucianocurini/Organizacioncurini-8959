CREATE TABLE `claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`claim_number` text,
	`status` text NOT NULL DEFAULT 'nuevo',
	-- Paso 2: datos del siniestro
	`incident_date` text,
	`incident_time` text,
	`incident_location` text,
	`incident_description` text,
	`damages` text,
	-- Tercero (automotor/moto)
	`third_party_name` text,
	`third_party_dni` text,
	`third_party_phone` text,
	`third_party_vehicle_plate` text,
	`third_party_vehicle_brand` text,
	`third_party_vehicle_model` text,
	`third_party_insurer` text,
	`third_party_policy_number` text,
	-- Paso 3: reclamo a compañía del tercero
	`claim_filed` integer DEFAULT 0,
	`claim_filed_date` text,
	`claim_company` text,
	`claim_number_third` text,
	`claim_notes` text,
	-- Paso 4: resolución
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
