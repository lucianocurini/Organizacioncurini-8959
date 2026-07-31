// Lógica pura de la interfaz de Envíos y Entregas (envios.tsx) — integración
// con Pólizas/Refacturaciones reales (Paso B, sobre el modelo de Paso A ya
// commiteado). Sin React, sin fetch: arma payloads, decide qué acción de
// transición está disponible y normaliza errores del backend — mismo estilo
// que policy-cancellation.ts / installments-rebuild.ts / rebilling-modal.ts.
// La autoridad final de todas las reglas de negocio (vínculo, duplicados,
// transiciones) sigue siendo siempre el backend — ver
// ../../lib/deliveries/validation.ts. Estos helpers nunca la reimplementan,
// solo preparan la solicitud y traducen la respuesta.

import {
  DELIVERY_CHANNELS, DELIVERY_DOCUMENT_TYPES, DELIVERY_STATUSES, DELIVERY_CHANNEL_PENDING,
  isValidChannel, isValidDocumentType,
  type DeliveryChannel, type DeliveryDocumentType,
} from "../../lib/deliveries/validation";

export { DELIVERY_CHANNELS, DELIVERY_DOCUMENT_TYPES, DELIVERY_STATUSES, DELIVERY_CHANNEL_PENDING };
export type { DeliveryChannel, DeliveryDocumentType };

// ─── 1. Alta rápida desde póliza/refacturación ("Agregar a Envíos") ────────
//
// Crea directamente un registro pendiente (POST /deliveries/quick-add) sin
// navegar ni abrir ningún modal — el usuario permanece en la póliza. El
// canal se completa después desde /envios ("Completar datos"). Reemplaza el
// mecanismo anterior de hidratación por query string (`?policyId=&
// rebillingId=&returnTo=`), que quedó obsoleto: ya no hace falta precargar
// un modal si el alta ocurre in-place.

export interface QuickAddDeliveryInput {
  policyId: number;
  documentType: DeliveryDocumentType;
  rebillingId: number | null;
}

/** Payload mínimo de POST /deliveries/quick-add — nunca incluye channel,
 * scheduledDate ni notes: el backend fuerza status="pendiente" y
 * channel=DELIVERY_CHANNEL_PENDING sin importar qué mande el body. */
export function buildQuickAddDeliveryPayload(input: QuickAddDeliveryInput) {
  return {
    policyId: input.policyId,
    documentType: input.documentType,
    rebillingId: input.documentType === "refacturacion" ? input.rebillingId : null,
  };
}

// ─── 2. "Datos por completar" — presentación del canal pendiente ───────────
//
// DELIVERY_CHANNEL_PENDING es un valor interno (persistido en DB por el alta
// rápida) que NUNCA debe mostrarse tal cual en la UI — isChannelPending +
// DELIVERY_CHANNEL_PENDING_LABEL son el único punto de traducción.

export const DELIVERY_CHANNEL_PENDING_LABEL = "Datos por completar";

/** true para el sentinel Y para cualquier otro valor no whitelisteado —
 * "sin canal real todavía" es la interpretación correcta en ambos casos. */
export function isChannelPending(channel: string): boolean {
  return !isValidChannel(channel);
}

// ─── 3. Detalle de póliza para el selector del modal completo (alta manual/vinculada) ─

export interface PolicyDetailForLinkedForm {
  policy: { id: number; policyNumber: string };
  insured: { name: string } | null;
  company: { name: string } | null;
  rebillings: Array<{ id: number; billingStart: string; billingEnd: string }>;
}

// ─── 4. Payload de alta — modo vinculado a póliza real ──────────────────────

export interface LinkedDeliveryFormState {
  policyId: number;
  documentType: DeliveryDocumentType;
  rebillingId: number | null;
  channel: DeliveryChannel | "";
  scheduledDate: string;
  notes: string;
}

/**
 * Validación de forma mínima antes de habilitar "Registrar envío" — nunca
 * reemplaza al backend (que revalida existencia y pertenencia real dentro
 * de resolveAndValidateDeliveryLink / validateDeliveryLink).
 */
export function validateLinkedDeliveryForm(form: LinkedDeliveryFormState): string | null {
  if (!isValidChannel(form.channel)) return "Seleccioná un canal de envío.";
  if (form.documentType === "refacturacion" && form.rebillingId == null) {
    return "Seleccioná una refacturación puntual de esta póliza.";
  }
  return null;
}

export function buildLinkedDeliveryPayload(form: LinkedDeliveryFormState) {
  return {
    policyId: form.policyId,
    rebillingId: form.documentType === "refacturacion" ? form.rebillingId : null,
    manualRecipient: null,
    manualPolicyNumber: null,
    manualCompany: null,
    documentType: form.documentType,
    channel: form.channel,
    scheduledDate: form.scheduledDate || null,
    notes: form.notes || null,
  };
}

// ─── 5. Payload de alta — modo manual (histórico, sin identidad formal) ─────

export interface ManualDeliveryFormState {
  manualRecipient: string;
  manualPolicyNumber: string;
  manualCompany: string;
  documentType: DeliveryDocumentType;
  channel: DeliveryChannel | "";
  scheduledDate: string;
  notes: string;
}

export function validateManualDeliveryForm(form: ManualDeliveryFormState): string | null {
  if (!isValidChannel(form.channel)) return "Seleccioná un canal de envío.";
  if (!form.manualRecipient.trim() && !form.manualPolicyNumber.trim()) {
    return "Completá al menos el destinatario o el N° de póliza.";
  }
  return null;
}

export function buildManualDeliveryPayload(form: ManualDeliveryFormState) {
  return {
    policyId: null,
    rebillingId: null,
    manualRecipient: form.manualRecipient.trim() || null,
    manualPolicyNumber: form.manualPolicyNumber.trim() || null,
    manualCompany: form.manualCompany.trim() || null,
    documentType: form.documentType,
    channel: form.channel,
    scheduledDate: form.scheduledDate || null,
    notes: form.notes || null,
  };
}

// ─── 6. Payload de edición — nunca vínculo, nunca estado/fechas de flujo ────

export interface DeliveryEditFormState {
  isManual: boolean;
  channel: DeliveryChannel | "";
  scheduledDate: string;
  notes: string;
  manualRecipient: string;
  manualPolicyNumber: string;
  manualCompany: string;
}

/**
 * Payload de PUT /deliveries/:id — SOLO canal, fecha programada, notas y (si
 * es un registro manual) sus datos descriptivos. Nunca incluye policyId,
 * rebillingId ni documentType (vínculo — UI conservadora en esta ronda: no
 * se cambia desde edición) ni status/sentDate/completedDate (exclusivos de
 * las transiciones dedicadas /send /deliver). Es la AUSENCIA real de la
 * clave la que importa — el backend solo pisa lo que está `in body`
 * (DELIVERY_PUT_FIELDS en index.ts), nunca manda `undefined` como sustituto.
 */
export function buildDeliveryEditPayload(form: DeliveryEditFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    channel: form.channel,
    scheduledDate: form.scheduledDate || null,
    notes: form.notes || null,
  };
  if (form.isManual) {
    payload.manualRecipient = form.manualRecipient.trim() || null;
    payload.manualPolicyNumber = form.manualPolicyNumber.trim() || null;
    payload.manualCompany = form.manualCompany.trim() || null;
  }
  return payload;
}

// ─── 7. Transiciones de estado (pendiente → enviado → entregado) ───────────

export type DeliveryTransitionKind = "send" | "deliver";

/**
 * null = sin acción de avance disponible. Cubre "entregado"/"realizado"
 * (terminales), cualquier status desconocido, Y "pendiente" sin canal real
 * todavía (alta rápida sin completar — mismo criterio que el guard nuevo de
 * validateSendTransition en el backend, replicado acá para no ofrecer un
 * botón que el backend va a rechazar). "realizado" es el estado legacy
 * histórico (solo escrito por PATCH /complete, que esta UI nueva nunca
 * invoca) y nunca ofrece "enviar"/"entregar" a partir de él.
 */
export function getAvailableDeliveryTransition(status: string, channel: string): DeliveryTransitionKind | null {
  if (status === "pendiente") return isValidChannel(channel) ? "send" : null;
  if (status === "enviado") return "deliver";
  return null;
}

export const DELIVERY_TRANSITION_ENDPOINT: Record<DeliveryTransitionKind, "send" | "deliver"> = {
  send: "send",
  deliver: "deliver",
};

export const DELIVERY_TRANSITION_COPY: Record<DeliveryTransitionKind, {
  actionLabel: string; confirmTitle: string; confirmBody: string;
}> = {
  send: {
    actionLabel: "Marcar como enviado",
    confirmTitle: "¿Marcar como enviado?",
    confirmBody: "El seguimiento va a pasar a estado \"enviado\" con la fecha de hoy.",
  },
  deliver: {
    actionLabel: "Marcar como entregado",
    confirmTitle: "¿Marcar como entregado?",
    confirmBody: "El seguimiento va a pasar a estado \"entregado\" con la fecha de hoy.",
  },
};

/**
 * Único punto de decisión de si una transición debe llamar a la API: hace
 * falta una acción disponible Y confirmación explícita. El componente solo
 * puede invocar api.patch cuando esto devuelve true — "Cancelar" en el
 * diálogo de confirmación siempre pasa confirmed=false y por lo tanto nunca
 * dispara la llamada.
 */
export function shouldExecuteDeliveryTransition(kind: DeliveryTransitionKind | null, confirmed: boolean): boolean {
  return kind != null && confirmed;
}

// ─── 8. Normalización de errores (400/404/409) ──────────────────────────────

export type DeliveryErrorKind = "validation" | "not_found" | "duplicate" | "unknown";

export interface NormalizedDeliveryError {
  kind: DeliveryErrorKind;
  message: string;
}

/**
 * `err` es el Error que lanza packages/web/src/web/lib/api.ts: .status viene
 * del código HTTP, .body es el JSON completo de la respuesta. El mensaje del
 * backend siempre se muestra tal cual (nunca se lo reemplaza por un genérico)
 * — es la fuente de verdad de por qué falló (p.ej. duplicado, vínculo
 * inválido, transición fuera de orden).
 */
export function normalizeDeliveryError(err: { status?: number; message?: string; body?: any }): NormalizedDeliveryError {
  const status = err?.status;
  const backendMessage = err?.body?.error || err?.message;
  if (status === 400) return { kind: "validation", message: backendMessage || "Los datos del seguimiento no son válidos." };
  if (status === 404) return { kind: "not_found", message: backendMessage || "El seguimiento, la póliza o la refacturación indicada ya no existe." };
  if (status === 409) return { kind: "duplicate", message: backendMessage || "Ya existe un seguimiento activo para este documento." };
  return { kind: "unknown", message: "No se pudo completar la operación." };
}

// ─── 9. Presentación de filas (tabla /envios) ───────────────────────────────

export interface DeliveryRowLike {
  delivery: {
    policyId: number | null;
    manualRecipient: string | null;
    manualPolicyNumber: string | null;
    manualCompany: string | null;
    documentType: string;
  };
  policy: { policyNumber: string } | null;
  insured: { name: string } | null;
  company: { name: string } | null;
  rebilling: { billingStart: string; billingEnd: string } | null;
}

export interface DeliveryRowDisplay {
  isManual: boolean;
  recipientName: string;
  companyName: string;
  policyNumber: string;
  period: { billingStart: string; billingEnd: string } | null;
}

/**
 * Filas manuales históricas (sin policyId) siguen mostrando exactamente lo
 * que se tipeó en su momento — nunca se intenta vincular retroactivamente a
 * una póliza real ni se crean seguimientos históricos automáticamente.
 */
export function getDeliveryRowDisplay(row: DeliveryRowLike): DeliveryRowDisplay {
  const isManual = row.delivery.policyId == null;
  return {
    isManual,
    recipientName: (isManual ? row.delivery.manualRecipient : row.insured?.name) || "—",
    companyName: (isManual ? row.delivery.manualCompany : row.company?.name) || "—",
    policyNumber: (isManual ? row.delivery.manualPolicyNumber : row.policy?.policyNumber) || "—",
    period: row.delivery.documentType === "refacturacion" && row.rebilling
      ? { billingStart: row.rebilling.billingStart, billingEnd: row.rebilling.billingEnd }
      : null,
  };
}

// ─── 10. Filtros ↔ query string (misma sincronización que Reporte mensual) ──

export interface DeliveriesFilters {
  status: string;
  channel: string;
  documentType: string;
  q: string;
}

export function parseDeliveriesFilters(search: string): DeliveriesFilters {
  const params = new URLSearchParams(search);
  const status = params.get("status") || "";
  const channel = params.get("channel") || "";
  const documentType = params.get("documentType") || "";
  const q = params.get("q") || "";
  return {
    status: (DELIVERY_STATUSES as readonly string[]).includes(status) ? status : "",
    channel: isValidChannel(channel) ? channel : "",
    documentType: isValidDocumentType(documentType) ? documentType : "",
    q: q.trim(),
  };
}

export function buildDeliveriesQuery(filters: DeliveriesFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.documentType) params.set("documentType", filters.documentType);
  const q = filters.q.trim();
  if (q) params.set("q", q);
  return params.toString();
}

export function buildDeliveriesPath(filters: DeliveriesFilters): string {
  const query = buildDeliveriesQuery(filters);
  return query ? `/envios?${query}` : "/envios";
}
