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
  nextRebillingDate: text("next_rebilling_date"), // próxima refacturación estimada — manual, independiente de start/end
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
  // Anulación manual (POST /api/policies/:id/cancel) — migración 0020.
  // status="cancelada" sigue siendo el estado operativo (mismo valor que ya
  // escriben los importadores); estos campos son auditoría adicional, nunca
  // cambian el significado de status ni de endDate.
  // cancellationEffectiveDate: desde cuándo la póliza deja de tener cobertura
  // real (puede no coincidir ni con endDate ni con la fecha en que se carga).
  // cancelledAt: cuándo se REGISTRÓ la anulación en el sistema (siempre "ahora"
  // al momento del POST, nunca editable por el usuario).
  // cancellationSource: 'manual' | 'importador' | null.
  //   'manual'     — cargada por un usuario vía el endpoint dedicado.
  //   'importador' — reservado para cuando los importadores lo completen
  //                  (deuda futura, no en esta vuelta — ver los 7 call-sites
  //                  de anulación en index.ts, que hoy no tocan este campo).
  //   null         — anulaciones históricas sin este campo, o cualquier
  //                  anulación fuera de los dos flujos anteriores.
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  cancellationEffectiveDate: text("cancellation_effective_date"),
  cancellationReason: text("cancellation_reason"),
  cancellationNotes: text("cancellation_notes"),
  cancelledBy: integer("cancelled_by").references(() => users.id),
  cancellationSource: text("cancellation_source"),
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
  // Etapa 4A: NULL para todo payment standalone (histórico o nuevo — sin
  // cambio de significado). Con valor: este payment es un HIJO de un cobro
  // múltiple (payment_batches) — sigue representando exactamente una cuota
  // (installmentId/policyId/amount sin cambios de semántica), pero sus
  // medios reales NO viven acá — ver comentario de paymentSplits más abajo.
  batchId: integer("batch_id").references(() => paymentBatches.id),
});

// Etapa 3A: desglose por medio de pago de un mismo payment. Todo payment
// STANDALONE (batchId IS NULL), incluso de un solo medio, tiene siempre al
// menos una fila acá (ver migración 0019 y
// src/lib/migrations/apply-0019-payment-splits.ts).
// payments.amount/paymentMethod NO cambian de significado — siguen siendo el
// total y el método resumen; esta tabla es información aditiva.
// CHECK amount_cents > 0 y el índice por payment_id se declaran en la
// migración 0019 (este proyecto no usa los helpers index()/check() de
// Drizzle — ver 0015_caja_propia.sql y 0017_installments_rebilling_id.sql).
//
// Etapa 4A — EXCEPCIÓN EXPLÍCITA a "todo payment tiene ≥1 split": un payment
// HIJO de un batch (payments.batchId NOT NULL) NO tiene ninguna fila acá.
// Sus medios reales viven una sola vez en payment_batch_splits del batch
// padre (nunca repartidos artificialmente entre las cuotas que cubre) — ver
// paymentBatches/paymentBatchSplits más abajo y src/lib/payments/batches.ts.
// El invariante "≥1 split" sigue vigente sin excepción para todo payment con
// batchId IS NULL.
export const paymentSplits = sqliteTable("payment_splits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  paymentId: integer("payment_id").notNull().references(() => payments.id),
  method: text("method").notNull(), // mismo vocabulario libre que payments.paymentMethod
  amountCents: integer("amount_cents").notNull(),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Etapa 4A: encabezado de un cobro que imputa varias cuotas del mismo
// asegurado (ej. un cheque/resumen que paga varias cuotas juntas). payments
// sigue representando una cuota individual (ver payments.batchId arriba) —
// este es el "recibo" real que las agrupa.
//
// baseAmountCents      = SUM(payments.amount) de sus hijos.
// surchargeAmountCents = recargos Pronto Pago aplicables ($800 por cuota
//                        Rivadavia elegible — nunca por recibo ni por
//                        póliza — ver src/lib/payments/batches.ts).
// totalReceivedCents   = baseAmountCents + surchargeAmountCents, y debe
//                        coincidir exactamente con SUM(paymentBatchSplits).
// CHECKs (base>0, surcharge>=0, total>0, status enum) e índices se declaran
// en la migración 0020 (mismo estilo SQL crudo que el resto del proyecto).
export const paymentBatches = sqliteTable("payment_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  insuredId: integer("insured_id").notNull().references(() => insureds.id),
  baseAmountCents: integer("base_amount_cents").notNull(),
  surchargeAmountCents: integer("surcharge_amount_cents").notNull().default(0),
  totalReceivedCents: integer("total_received_cents").notNull(),
  paymentDate: text("payment_date").notNull(),
  status: text("status").notNull().default("confirmado"), // confirmado | anulado
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Etapa 4A: medios reales de un payment_batches — una sola vez por medio,
// nunca repartidos entre las cuotas que el batch cubre (ver comentario de
// paymentSplits más arriba). method NUNCA es "lote" ni "combinado" (esos son
// valores de resumen del payment padre/hijo, no medios reales) — mismo
// vocabulario real que ya usa payment_splits.method. CHECK de método/importe
// e índices se declaran en la migración 0021.
export const paymentBatchSplits = sqliteTable("payment_batch_splits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id").notNull().references(() => paymentBatches.id),
  method: text("method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Etapa 4B: cheques físicos concretos que componen un payment_batch_splits
// con method='cheque'. Un split cheque puede estar compuesto por uno o varios
// received_checks — nunca al revés, y un cheque NUNCA apunta directamente a
// un payment hijo ni a una cuota (esa relación es siempre indirecta, a
// través del batch_split -> batch -> payments hijos). SUM(amountCents) de los
// received_checks de un batchSplitId debe ser exactamente el amountCents de
// ese payment_batch_splits (ver migración 0022 y
// src/lib/payments/received-checks.ts).
//
// status: en_cartera -> entregado_compania -> cobrado | rechazado
// (terminales); anulado solo alcanzable desde en_cartera. Deliberadamente sin
// estado "depositado" en esta etapa. Transiciones válidas se validan en
// src/lib/payments/received-checks.ts (validateCheckStatusTransition), no acá
// — el CHECK de la migración 0022 solo restringe el vocabulario posible.
export const receivedChecks = sqliteTable("received_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchSplitId: integer("batch_split_id").notNull().references(() => paymentBatchSplits.id),
  checkNumber: text("check_number").notNull(),
  bankName: text("bank_name").notNull(),
  bankCode: text("bank_code"),
  drawerName: text("drawer_name"),
  drawerDocument: text("drawer_document"),
  issueDate: text("issue_date"),
  dueDate: text("due_date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("ARS"),
  status: text("status").notNull().default("en_cartera"),
  notes: text("notes"),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  clearedAt: integer("cleared_at", { mode: "timestamp" }),
  rejectedAt: integer("rejected_at", { mode: "timestamp" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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
  status: text("status").notNull().default("pendiente"), // pendiente | pagada | vencida | no_exigible
  // no_exigible: la póliza dueña fue anulada manualmente (ver policies.cancelledAt)
  // con effectiveDate <= dueDate — la cuota deja de ser cobrable, pero nunca se
  // borra ni se confunde con "pagada" (ver src/lib/policies/cancellation.ts).
  notes: text("notes"),
  rendered: integer("rendered").notNull().default(0), // 1 = rendida a compañía sin cobrar al asegurado
  renderedAt: integer("rendered_at", { mode: "timestamp" }),
  // null = cuota base de la póliza; con valor = generada por esa refacturación puntual
  rebillingId: integer("rebilling_id").references(() => rebillings.id),
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
