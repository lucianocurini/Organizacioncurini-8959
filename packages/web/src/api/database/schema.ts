import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(), // hashed
  role: text("role").notNull().default("user"), // admin | user
  active: integer("active").notNull().default(1), // 1 = activo, 0 = suspendido
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  cuit: text("cuit"),
  phone: text("phone"),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const insureds = sqliteTable("insureds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  dni: text("dni"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const policies = sqliteTable("policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyNumber: text("policy_number").notNull(),
  type: text("type").notNull(), // automotor | hogar | accidentes | comercial
  status: text("status").notNull().default("activa"), // activa | vencida | cancelada | por_vencer
  companyId: integer("company_id").notNull().references(() => companies.id),
  insuredId: integer("insured_id").notNull().references(() => insureds.id),
  premium: real("premium"), // prima / monto base
  sumInsured: real("sum_insured"), // suma asegurada
  coverageType: text("coverage_type"), // tipo de cobertura
  monthlyFee: real("monthly_fee"), // cuota mensual
  deductible: real("deductible"), // franquicia
  billingCycle: text("billing_cycle"), // refacturación: mensual | trimestral | cuatrimestral | semestral
  installments: integer("installments"), // cantidad de cuotas
  vigencyPeriod: text("vigency_period"), // anual | semestral | cuatrimestral
  paymentMethod: text("payment_method"), // manual | cbu | tarjeta_credito
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  notes: text("notes"),
  // Automotor specific
  vehicleBrand: text("vehicle_brand"),
  vehicleModel: text("vehicle_model"),
  vehicleYear: integer("vehicle_year"),
  vehiclePlate: text("vehicle_plate"),
  isFleet: integer("is_fleet").notNull().default(0), // 0=individual, 1=flota
  // Hogar specific
  propertyAddress: text("property_address"),
  // Motovehiculo specific
  motoBrand: text("moto_brand"),
  motoModel: text("moto_model"),
  motoYear: integer("moto_year"),
  motoPlate: text("moto_plate"),
  motoEngine: text("moto_engine"),
  // Comercial specific
  businessName: text("business_name"),
  businessActivity: text("business_activity"),
  isRebilling: integer("is_rebilling").notNull().default(0), // 0=póliza original, 1=refacturación importada
  renewedFromId: integer("renewed_from_id"), // id de la póliza anterior que renueva
  parentPolicyId: integer("parent_policy_id"), // id de la póliza principal (ej: auto para accidentes_pasajeros)
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").references(() => policies.id), // nullable — imputación manual sin póliza
  manualPayer: text("manual_payer"),
  manualPolicyNumber: text("manual_policy_number"),
  manualCompany: text("manual_company"),
  amount: real("amount").notNull(),
  paymentMethod: text("payment_method").notNull(), // efectivo | transferencia | cheque | link_pago
  paymentDate: text("payment_date").notNull(),
  periodMonth: text("period_month"), // e.g. "2024-03" — mes al que corresponde
  notes: text("notes"),
  status: text("status").notNull().default("confirmado"), // confirmado | pendiente | anulado
  rendered: integer("rendered").notNull().default(0), // 0 = en cartera, 1 = rendido
  renderedAt: integer("rendered_at", { mode: "timestamp" }),
  installmentId: integer("installment_id").references(() => policyInstallments.id),
  dueDate: text("due_date"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const deliveries = sqliteTable("deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").references(() => policies.id), // nullable — envío manual sin póliza
  manualRecipient: text("manual_recipient"),
  manualPolicyNumber: text("manual_policy_number"),
  manualCompany: text("manual_company"),
  documentType: text("document_type").notNull(), // poliza | refacturacion
  channel: text("channel").notNull(), // whatsapp | email | copia_cliente | retiro_oficina
  status: text("status").notNull().default("pendiente"), // pendiente | realizado
  scheduledDate: text("scheduled_date"),
  completedDate: text("completed_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const claims = sqliteTable("claims", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").references(() => policies.id), // nullable — puede no tener póliza vinculada
  claimNumber: text("claim_number"),
  status: text("status").notNull().default("pendiente"), // pendiente | nuevo | en_curso | reclamo_tercero | resuelto
  // Datos manuales (cuando no hay póliza vinculada)
  manualInsured: text("manual_insured"),
  manualCompany: text("manual_company"),
  manualPolicyNumber: text("manual_policy_number"),
  manualPolicyType: text("manual_policy_type"),
  manualNotes: text("manual_notes"),
  // Paso 2
  incidentDate: text("incident_date"),
  incidentTime: text("incident_time"),
  incidentLocation: text("incident_location"),
  incidentDescription: text("incident_description"),
  damages: text("damages"),
  // Tercero
  thirdPartyName: text("third_party_name"),
  thirdPartyDni: text("third_party_dni"),
  thirdPartyPhone: text("third_party_phone"),
  thirdPartyVehiclePlate: text("third_party_vehicle_plate"),
  thirdPartyVehicleBrand: text("third_party_vehicle_brand"),
  thirdPartyVehicleModel: text("third_party_vehicle_model"),
  thirdPartyInsurer: text("third_party_insurer"),
  thirdPartyPolicyNumber: text("third_party_policy_number"),
  // Paso 3
  claimFiled: integer("claim_filed").default(0),
  claimFiledDate: text("claim_filed_date"),
  claimCompany: text("claim_company"),
  claimNumberThird: text("claim_number_third"),
  claimNotes: text("claim_notes"),
  // Paso 4
  resolved: integer("resolved").default(0),
  resolvedDate: text("resolved_date"),
  resolutionNotes: text("resolution_notes"),
  resolutionAmount: real("resolution_amount"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Personas aseguradas dentro de una póliza (accidentes / ART)
export const policyInsuredPersons = sqliteTable("policy_insured_persons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").notNull().references(() => policies.id),
  name: text("name").notNull(),
  dni: text("dni"),
  birthDate: text("birth_date"),       // YYYY-MM-DD
  relationship: text("relationship"),  // titular | cónyuge | hijo | empleado | otro
  phone: text("phone"),
  email: text("email"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const policyFleetVehicles = sqliteTable("policy_fleet_vehicles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").notNull().references(() => policies.id),
  brand: text("brand"),
  model: text("model"),
  year: integer("year"),
  plate: text("plate"),           // patente
  chasis: text("chasis"),         // número de chasis
  engine: text("engine"),         // número de motor
  color: text("color"),
  sumInsured: real("sum_insured"), // suma asegurada individual
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const policyInstallments = sqliteTable("policy_installments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").notNull().references(() => policies.id),
  number: integer("number").notNull(),
  dueDate: text("due_date").notNull(),
  amount: real("amount").notNull(),
  status: text("status").notNull().default("pendiente"), // pendiente | pagada | vencida
  notes: text("notes"),
  rendered: integer("rendered").notNull().default(0), // 1 = rendida a compañía sin cobrar al asegurado
  renderedAt: integer("rendered_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const rebillings = sqliteTable("rebillings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyId: integer("policy_id").notNull().references(() => policies.id),
  billingStart: text("billing_start").notNull(),
  billingEnd: text("billing_end").notNull(),
  premium: real("premium"),
  monthlyFee: real("monthly_fee"),
  sumInsured: real("sum_insured"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

// ─── TASKS ────────────────────────────────────────────────────────────────────
// Templates: tareas fijas mensuales
export const taskTemplates = sqliteTable("task_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  dayOfMonth: integer("day_of_month"), // 1-28 o null = sin fecha fija
  order: integer("order").notNull().default(0),
  active: integer("active").notNull().default(1),
  isAdminOnly: integer("is_admin_only").notNull().default(0), // 1 = solo visible para admin
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Tasks: instancias (fijas o únicas)
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  templateId: integer("template_id").references(() => taskTemplates.id), // null = tarea única
  monthYear: text("month_year").notNull(), // "2026-05" format
  title: text("title").notNull(),
  description: text("description"),
  dueDate: text("due_date"), // fecha específica YYYY-MM-DD opcional
  status: text("status").notNull().default("pendiente"), // pendiente | realizada
  isRecurring: integer("is_recurring").notNull().default(0), // 1 = generada desde template
  isAdminOnly: integer("is_admin_only").notNull().default(0), // 1 = solo visible para admin
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

// ─── IMPORT LOGS ──────────────────────────────────────────────────────────────
export const importLogs = sqliteTable("import_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(), // "gmail" | "manual"
  filename: text("filename"),
  gmailMessageId: text("gmail_message_id").unique(),
  fechaArchivo: text("fecha_archivo"), // YYYY-MM-DD del archivo importado
  importedAt: integer("imported_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  status: text("status").notNull().default("ok"), // "ok" | "error" | "partial"
  registrosImportados: integer("registros_importados").notNull().default(0),
  rebillings: integer("rebillings").notNull().default(0),
  endosos: integer("endosos").notNull().default(0),
  anulaciones: integer("anulaciones").notNull().default(0),
  duplicados: integer("duplicados").notNull().default(0),
  revisar: integer("revisar").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: text("errors"), // JSON array of strings
  createdBy: integer("created_by").references(() => users.id),
});

// ─── CAJA ─────────────────────────────────────────────────────────────────────
// Cobros manuales (no vienen de Cobranzas/payments)
export const cashEntries = sqliteTable("cash_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientName: text("client_name").notNull(),
  policyNumber: text("policy_number"),
  companyName: text("company_name"),
  amount: real("amount").notNull(),
  paymentMethod: text("payment_method").notNull(), // efectivo | transferencia | cheque
  paymentDate: text("payment_date").notNull(),    // YYYY-MM-DD
  dueDate: text("due_date"),
  notes: text("notes"),
  rendered: integer("rendered").notNull().default(0),
  renderedAt: integer("rendered_at", { mode: "timestamp" }),
  entryType: text("entry_type").notNull().default("normal"), // normal | pronto_pago_surcharge
  paymentId: integer("payment_id").references(() => payments.id), // único por payment cuando entry_type = 'pronto_pago_surcharge' (ver ux_cash_entries_pronto_pago_payment)
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Adeudados por asegurados
export const cashDebts = sqliteTable("cash_debts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientName: text("client_name").notNull(),
  policyNumber: text("policy_number"),
  companyName: text("company_name"),
  amount: real("amount").notNull(),
  dueDate: text("due_date"),
  notes: text("notes"),
  status: text("status").notNull().default("pendiente"), // pendiente | cobrado
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ─── RENDICIONES ──────────────────────────────────────────────────────────────
export const remittances = sqliteTable("remittances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  canal: text("canal").notNull(),
  notes: text("notes"),
  paymentBreakdown: text("payment_breakdown").notNull().default("{}"),
  prontoPagoSurcharge: real("pronto_pago_surcharge").default(0),
  totalAmount: real("total_amount").notNull().default(0),
  totalPaid: real("total_paid").notNull().default(0),
  status: text("status").notNull().default("confirmada"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const remittanceItems = sqliteTable("remittance_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  remittanceId: integer("remittance_id").notNull().references(() => remittances.id),
  source: text("source").notNull(),
  sourceId: integer("source_id"),
  amount: real("amount").notNull(),
  debtorStatus: text("debtor_status").notNull().default("pagado"),
  paidAt: integer("paid_at", { mode: "timestamp" }),
  clientName: text("client_name"),
  policyNumber: text("policy_number"),
  companyName: text("company_name"),
  paymentMethod: text("payment_method"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ─── GASTOS DE CAJA ──────────────────────────────────────────────────────────
export const cashExpenses = sqliteTable("cash_expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  category: text("category"),
  notes: text("notes"),
  type: text("type").notNull().default("gasto_operativo"), // gasto_operativo | sueldo
  paymentMethod: text("payment_method").notNull().default("efectivo"),
  payeeName: text("payee_name"),
  salaryPeriod: text("salary_period"),
  status: text("status").notNull().default("registrado"), // registrado | conciliado | anulado
  reconciledAt: integer("reconciled_at", { mode: "timestamp" }),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ─── COMISIONES ───────────────────────────────────────────────────────────────
export const commissionEntries = sqliteTable("commission_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  date: text("date").notNull(),
  amount: real("amount").notNull(),
  notes: text("notes"),
  paymentMethod: text("payment_method").notNull().default("transferencia"),
  periodMonth: text("period_month"),
  status: text("status").notNull().default("registrado"), // registrado | anulado
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ─── IVA ──────────────────────────────────────────────────────────────────────
export const ivaEntries = sqliteTable("iva_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  date: text("date").notNull(),
  amount: real("amount").notNull(),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ─── CAJA PROPIA ──────────────────────────────────────────────────────────────
// CHECK en DB: type IN ('aporte','reintegro'), amount > 0,
//              payment_method IN ('efectivo','transferencia'), status IN ('registrado','anulado')
export const ownMoneyMovements = sqliteTable("own_money_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // aporte | reintegro
  date: text("date").notNull(),
  amount: real("amount").notNull(), // > 0
  paymentMethod: text("payment_method").notNull().default("efectivo"), // efectivo | transferencia
  status: text("status").notNull().default("registrado"), // registrado | anulado
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
