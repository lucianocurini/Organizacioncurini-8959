// Validación pura del alta/edición de un seguimiento de Envíos y Entregas
// (POST/PUT /api/deliveries) e integración formal con pólizas/refacturaciones
// — Paso A (solo modelo/backend, sin frontend todavía). Sin DB, sin efectos
// secundarios: recibe datos ya resueltos por el endpoint (que sí consulta la
// base) y devuelve resultados explícitos o lanza errores tipados, mismo
// estilo que src/lib/policies/cancellation.ts y src/lib/payments/batches.ts.

export const DELIVERY_DOCUMENT_TYPES = ["poliza", "refacturacion"] as const;
export type DeliveryDocumentType = typeof DELIVERY_DOCUMENT_TYPES[number];

export const DELIVERY_CHANNELS = ["whatsapp", "email", "copia_cliente", "retiro_oficina"] as const;
export type DeliveryChannel = typeof DELIVERY_CHANNELS[number];

// Sentinel de "canal aún no definido" — usado exclusivamente por el alta
// rápida desde póliza/refacturación (POST /deliveries/quick-add). Vive a
// propósito FUERA de DELIVERY_CHANNELS: cualquier chequeo existente que use
// isValidChannel() lo trata como canal inválido, que es justo lo que hace
// falta para bloquear /send y el guardado normal de POST/PUT hasta que se
// complete con un canal real ("Completar datos" en /envios). Nunca se
// expone tal cual al usuario — la UI siempre lo traduce a un label
// ("Datos por completar"), nunca lo imprime crudo.
export const DELIVERY_CHANNEL_PENDING = "sin_definir";

// "realizado" se conserva como valor histórico admitido (solo escrito hoy
// por el PATCH /complete legacy, nunca por POST/PUT) — ver comentario de
// coexistencia en index.ts, bloque DELIVERIES.
export const DELIVERY_STATUSES = ["pendiente", "enviado", "entregado", "realizado"] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

// "activos" = compiten por duplicado (ver hasActiveDuplicateDelivery).
// entregado/realizado son estados terminales — permiten reenvío (decisión
// de negocio explícita).
export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pendiente", "enviado"];

export class DeliveryValidationError extends Error {}
export class DeliveryDuplicateError extends Error {}
export class DeliveryStatusTransitionError extends Error {}

export function isValidDocumentType(value: unknown): value is DeliveryDocumentType {
  return typeof value === "string" && (DELIVERY_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function isValidChannel(value: unknown): value is DeliveryChannel {
  return typeof value === "string" && (DELIVERY_CHANNELS as readonly string[]).includes(value);
}

// ─── Vínculo con póliza/refacturación ───────────────────────────────────────

export interface DeliveryLinkInput {
  policyId: number | null;
  rebillingId: number | null;
  documentType: string;
}

export interface RebillingRef {
  id: number;
  policyId: number;
}

/**
 * Reglas de vínculo (decisión de negocio, Paso A):
 *  - policyId null (registro manual) → rebillingId debe ser null también.
 *    Sin más validación — histórico, sin identidad formal.
 *  - documentType="poliza" + policyId → rebillingId debe ser null.
 *  - documentType="refacturacion" + policyId → rebillingId es OBLIGATORIO, y
 *    la refacturación referenciada debe pertenecer a esa policyId exacta.
 *
 * No valida existencia real de policyId/rebillingId en DB — el caller ya
 * los buscó antes de llamar (pasa `rebilling` null si no encontró la fila;
 * la existencia de policyId se valida aparte, con un 404 propio, antes de
 * siquiera llegar a esta función).
 */
export function validateDeliveryLink(input: DeliveryLinkInput, rebilling: RebillingRef | null | undefined): void {
  if (!isValidDocumentType(input.documentType)) {
    throw new DeliveryValidationError(
      `documentType inválido: "${input.documentType}". Valores permitidos: ${DELIVERY_DOCUMENT_TYPES.join(", ")}.`
    );
  }

  if (input.policyId == null) {
    if (input.rebillingId != null) {
      throw new DeliveryValidationError("Un registro manual (sin policyId) no puede tener rebillingId.");
    }
    return;
  }

  if (input.documentType === "poliza") {
    if (input.rebillingId != null) {
      throw new DeliveryValidationError(
        "Un seguimiento de tipo 'poliza' no puede tener rebillingId — usá documentType 'refacturacion' para vincular una refacturación puntual."
      );
    }
    return;
  }

  // documentType === "refacturacion"
  if (input.rebillingId == null) {
    throw new DeliveryValidationError(
      "Un seguimiento de tipo 'refacturacion' vinculado a una póliza requiere rebillingId."
    );
  }
  if (!rebilling) {
    throw new DeliveryValidationError("La refacturación indicada no existe.");
  }
  if (rebilling.policyId !== input.policyId) {
    throw new DeliveryValidationError("La refacturación indicada no pertenece a la póliza informada.");
  }
}

// ─── Anti-duplicados ─────────────────────────────────────────────────────────

export interface ExistingDeliveryForDuplicateCheck {
  id: number;
  policyId: number | null;
  rebillingId: number | null;
  documentType: string;
  status: string;
}

/**
 * true si YA existe otro seguimiento ACTIVO (pendiente|enviado) para el
 * mismo documento real:
 *  - documentType="poliza": mismo policyId.
 *  - documentType="refacturacion": mismo rebillingId (no alcanza con el
 *    mismo policyId — dos refacturaciones distintas de la misma póliza son
 *    documentos distintos, cada una puede tener su propio seguimiento).
 *
 * Registros manuales (policyId null) NUNCA compiten por duplicado — sin
 * identidad formal, por decisión de negocio explícita (no se audita ni
 * infiere qué póliza real representan).
 *
 * excludeId permite excluir el propio registro durante una edición (PUT).
 */
export function hasActiveDuplicateDelivery(
  candidate: { policyId: number | null; rebillingId: number | null; documentType: string },
  existing: ExistingDeliveryForDuplicateCheck[],
  excludeId?: number | null
): boolean {
  if (candidate.policyId == null) return false;
  return existing.some((row) => {
    if (excludeId != null && row.id === excludeId) return false;
    if (!(ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(row.status)) return false;
    if (row.documentType !== candidate.documentType) return false;
    if (candidate.documentType === "refacturacion") {
      return row.rebillingId != null && row.rebillingId === candidate.rebillingId;
    }
    return row.policyId === candidate.policyId;
  });
}

// ─── Transiciones de estado ──────────────────────────────────────────────────
// Flujo vigente, estrictamente lineal: pendiente → enviado → entregado. Cada
// transición exige el estado previo EXACTO — sin saltos (pendiente →
// entregado directo) ni regresiones. PATCH /complete (legacy) es una puerta
// de entrada aparte, sin estas reglas — ver coexistencia documentada en
// index.ts.

/**
 * channel es el valor ACTUAL de la fila (no el del body) — un seguimiento
 * creado por el alta rápida (POST /deliveries/quick-add) arranca con
 * DELIVERY_CHANNEL_PENDING y no puede avanzar a "enviado" hasta que
 * "Completar datos" le asigne un canal real (isValidChannel). Mismo
 * criterio que el resto de este archivo: la whitelist de canal vive acá,
 * nunca en un CHECK de esquema.
 */
export function validateSendTransition(currentStatus: string, channel: string): void {
  if (currentStatus !== "pendiente") {
    throw new DeliveryStatusTransitionError(
      `No se puede marcar como enviado un seguimiento en estado "${currentStatus}" — solo se puede enviar desde "pendiente".`
    );
  }
  if (!isValidChannel(channel)) {
    throw new DeliveryStatusTransitionError(
      "No se puede marcar como enviado sin un canal definido. Completá los datos del envío primero."
    );
  }
}

export function validateDeliverTransition(currentStatus: string): void {
  if (currentStatus !== "enviado") {
    throw new DeliveryStatusTransitionError(
      `No se puede marcar como entregado un seguimiento en estado "${currentStatus}" — solo se puede entregar desde "enviado".`
    );
  }
}
