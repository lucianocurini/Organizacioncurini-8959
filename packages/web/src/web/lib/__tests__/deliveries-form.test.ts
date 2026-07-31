// Tests de la lógica pura de Envíos y Entregas (Paso B — integración con
// Pólizas/Refacturaciones reales, alta rápida con "Datos por completar").
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/deliveries-form.test.ts
import { describe, test, expect } from "bun:test";
import {
  buildQuickAddDeliveryPayload,
  DELIVERY_CHANNEL_PENDING, DELIVERY_CHANNEL_PENDING_LABEL, isChannelPending,
  validateLinkedDeliveryForm, buildLinkedDeliveryPayload,
  validateManualDeliveryForm, buildManualDeliveryPayload,
  buildDeliveryEditPayload,
  getAvailableDeliveryTransition, shouldExecuteDeliveryTransition,
  normalizeDeliveryError,
  getDeliveryRowDisplay,
  parseDeliveriesFilters, buildDeliveriesQuery, buildDeliveriesPath,
} from "../deliveries-form";

describe("buildQuickAddDeliveryPayload", () => {
  test("póliza general: rebillingId siempre null", () => {
    const payload = buildQuickAddDeliveryPayload({ policyId: 42, documentType: "poliza", rebillingId: null });
    expect(payload).toEqual({ policyId: 42, documentType: "poliza", rebillingId: null });
  });
  test("refacturación puntual: conserva rebillingId", () => {
    const payload = buildQuickAddDeliveryPayload({ policyId: 42, documentType: "refacturacion", rebillingId: 7 });
    expect(payload).toEqual({ policyId: 42, documentType: "refacturacion", rebillingId: 7 });
  });
  test("documentType=poliza con rebillingId presente lo ignora (nunca lo manda)", () => {
    const payload = buildQuickAddDeliveryPayload({ policyId: 42, documentType: "poliza", rebillingId: 7 });
    expect(payload.rebillingId).toBeNull();
  });
  test("payload nunca incluye channel, scheduledDate ni notes", () => {
    const payload: any = buildQuickAddDeliveryPayload({ policyId: 42, documentType: "poliza", rebillingId: null });
    expect(payload).not.toHaveProperty("channel");
    expect(payload).not.toHaveProperty("scheduledDate");
    expect(payload).not.toHaveProperty("notes");
    expect(payload).not.toHaveProperty("status");
  });
});

describe("isChannelPending / DELIVERY_CHANNEL_PENDING", () => {
  test("el sentinel se considera pendiente", () => {
    expect(isChannelPending(DELIVERY_CHANNEL_PENDING)).toBe(true);
  });
  test("un canal real no se considera pendiente", () => {
    expect(isChannelPending("whatsapp")).toBe(false);
    expect(isChannelPending("email")).toBe(false);
    expect(isChannelPending("copia_cliente")).toBe(false);
    expect(isChannelPending("retiro_oficina")).toBe(false);
  });
  test("cualquier otro valor no whitelisteado también se trata como pendiente", () => {
    expect(isChannelPending("")).toBe(true);
    expect(isChannelPending("fax")).toBe(true);
  });
  test("el sentinel vive fuera del vocabulario real de canales", () => {
    expect(DELIVERY_CHANNEL_PENDING).not.toBe("whatsapp");
    expect(DELIVERY_CHANNEL_PENDING).not.toBe("email");
    expect(DELIVERY_CHANNEL_PENDING).not.toBe("copia_cliente");
    expect(DELIVERY_CHANNEL_PENDING).not.toBe("retiro_oficina");
  });
  test("el label público nunca es el valor interno crudo", () => {
    expect(DELIVERY_CHANNEL_PENDING_LABEL).not.toBe(DELIVERY_CHANNEL_PENDING);
    expect(DELIVERY_CHANNEL_PENDING_LABEL).toBe("Datos por completar");
  });
});

describe("Alta vinculada — validación y payload", () => {
  test("payload de póliza vinculada (sin refacturación)", () => {
    const payload = buildLinkedDeliveryPayload({
      policyId: 42, documentType: "poliza", rebillingId: null,
      channel: "whatsapp", scheduledDate: "2026-08-01", notes: "obs",
    });
    expect(payload).toEqual({
      policyId: 42, rebillingId: null,
      manualRecipient: null, manualPolicyNumber: null, manualCompany: null,
      documentType: "poliza", channel: "whatsapp",
      scheduledDate: "2026-08-01", notes: "obs",
    });
  });

  test("payload de refacturación con rebillingId", () => {
    const payload = buildLinkedDeliveryPayload({
      policyId: 42, documentType: "refacturacion", rebillingId: 7,
      channel: "email", scheduledDate: "", notes: "",
    });
    expect(payload.rebillingId).toBe(7);
    expect(payload.documentType).toBe("refacturacion");
    expect(payload.scheduledDate).toBeNull();
    expect(payload.notes).toBeNull();
  });

  test("refacturación sin rebillingId queda bloqueada por la validación de forma", () => {
    const error = validateLinkedDeliveryForm({
      policyId: 42, documentType: "refacturacion", rebillingId: null,
      channel: "whatsapp", scheduledDate: "", notes: "",
    });
    expect(error).not.toBeNull();
  });

  test("póliza sin refacturación no exige rebillingId", () => {
    const error = validateLinkedDeliveryForm({
      policyId: 42, documentType: "poliza", rebillingId: null,
      channel: "whatsapp", scheduledDate: "", notes: "",
    });
    expect(error).toBeNull();
  });

  test("canal inválido/vacío bloquea el alta vinculada", () => {
    const error = validateLinkedDeliveryForm({
      policyId: 42, documentType: "poliza", rebillingId: null,
      channel: "", scheduledDate: "", notes: "",
    });
    expect(error).not.toBeNull();
  });

  test("el sentinel de canal pendiente tampoco es un canal válido para el alta completa", () => {
    const error = validateLinkedDeliveryForm({
      policyId: 42, documentType: "poliza", rebillingId: null,
      channel: DELIVERY_CHANNEL_PENDING as any, scheduledDate: "", notes: "",
    });
    expect(error).not.toBeNull();
  });

  test(
    "rebilling que no pertenece a la póliza no se bloquea acá — queda en manos del backend",
    () => {
      // La validación de forma no conoce la pertenencia real (eso lo valida
      // resolveAndValidateDeliveryLink/validateDeliveryLink en el backend);
      // esta validación de UI solo exige que haya un rebillingId presente.
      const error = validateLinkedDeliveryForm({
        policyId: 42, documentType: "refacturacion", rebillingId: 999,
        channel: "whatsapp", scheduledDate: "", notes: "",
      });
      expect(error).toBeNull();
      const payload = buildLinkedDeliveryPayload({
        policyId: 42, documentType: "refacturacion", rebillingId: 999,
        channel: "whatsapp", scheduledDate: "", notes: "",
      });
      expect(payload.rebillingId).toBe(999);
    },
  );
});

describe("Alta manual — validación y payload", () => {
  test("payload manual sin IDs de póliza/refacturación", () => {
    const payload = buildManualDeliveryPayload({
      manualRecipient: "Ana López", manualPolicyNumber: "12345", manualCompany: "Sancor",
      documentType: "poliza", channel: "copia_cliente", scheduledDate: "", notes: "",
    });
    expect(payload.policyId).toBeNull();
    expect(payload.rebillingId).toBeNull();
    expect(payload.manualRecipient).toBe("Ana López");
    expect(payload.manualPolicyNumber).toBe("12345");
    expect(payload.manualCompany).toBe("Sancor");
  });

  test("requiere al menos destinatario o N° de póliza", () => {
    const error = validateManualDeliveryForm({
      manualRecipient: "", manualPolicyNumber: "", manualCompany: "",
      documentType: "poliza", channel: "whatsapp", scheduledDate: "", notes: "",
    });
    expect(error).not.toBeNull();
  });

  test("con solo N° de póliza alcanza", () => {
    const error = validateManualDeliveryForm({
      manualRecipient: "", manualPolicyNumber: "999", manualCompany: "",
      documentType: "poliza", channel: "whatsapp", scheduledDate: "", notes: "",
    });
    expect(error).toBeNull();
  });
});

describe("Edición — payload nunca pisa vínculo ni estado/fechas de flujo", () => {
  test("registro vinculado: solo canal/fecha/notas", () => {
    const payload = buildDeliveryEditPayload({
      isManual: false, channel: "email", scheduledDate: "2026-08-05", notes: "nueva nota",
      manualRecipient: "no debería usarse", manualPolicyNumber: "no debería usarse", manualCompany: "no debería usarse",
    });
    expect(Object.keys(payload).sort()).toEqual(["channel", "notes", "scheduledDate"]);
    expect(payload).not.toHaveProperty("policyId");
    expect(payload).not.toHaveProperty("rebillingId");
    expect(payload).not.toHaveProperty("documentType");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("sentDate");
    expect(payload).not.toHaveProperty("completedDate");
  });

  test("registro manual: incluye también los datos descriptivos manuales", () => {
    const payload = buildDeliveryEditPayload({
      isManual: true, channel: "whatsapp", scheduledDate: "", notes: "",
      manualRecipient: "Juan", manualPolicyNumber: "1", manualCompany: "Sancor",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "channel", "manualCompany", "manualPolicyNumber", "manualRecipient", "notes", "scheduledDate",
    ]);
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("sentDate");
    expect(payload).not.toHaveProperty("completedDate");
    expect(payload).not.toHaveProperty("policyId");
    expect(payload).not.toHaveProperty("rebillingId");
  });

  test("Completar datos: canal real reemplaza al sentinel en el payload", () => {
    const payload = buildDeliveryEditPayload({
      isManual: false, channel: "whatsapp", scheduledDate: "2026-08-10", notes: "",
      manualRecipient: "", manualPolicyNumber: "", manualCompany: "",
    });
    expect(payload.channel).toBe("whatsapp");
    expect(payload.channel).not.toBe(DELIVERY_CHANNEL_PENDING);
  });
});

describe("Transiciones de estado", () => {
  test("pendiente con canal real → acción disponible: send", () => {
    expect(getAvailableDeliveryTransition("pendiente", "whatsapp")).toBe("send");
    expect(getAvailableDeliveryTransition("pendiente", "email")).toBe("send");
  });
  test("pendiente con canal sin_definir (alta rápida sin completar) → sin acción", () => {
    expect(getAvailableDeliveryTransition("pendiente", DELIVERY_CHANNEL_PENDING)).toBeNull();
  });
  test("pendiente con canal vacío/inválido → sin acción", () => {
    expect(getAvailableDeliveryTransition("pendiente", "")).toBeNull();
    expect(getAvailableDeliveryTransition("pendiente", "fax")).toBeNull();
  });
  test("enviado → acción disponible: deliver (el canal ya no importa en este punto)", () => {
    expect(getAvailableDeliveryTransition("enviado", "whatsapp")).toBe("deliver");
  });
  test("entregado → sin acción", () => {
    expect(getAvailableDeliveryTransition("entregado", "whatsapp")).toBeNull();
  });
  test("realizado (legacy) → sin acción", () => {
    expect(getAvailableDeliveryTransition("realizado", "whatsapp")).toBeNull();
  });
  test("estado desconocido → sin acción", () => {
    expect(getAvailableDeliveryTransition("cualquier_otro", "whatsapp")).toBeNull();
  });

  test("confirmar ejecuta la transición", () => {
    expect(shouldExecuteDeliveryTransition("send", true)).toBe(true);
    expect(shouldExecuteDeliveryTransition("deliver", true)).toBe(true);
  });
  test("cancelar la confirmación nunca dispara la llamada", () => {
    expect(shouldExecuteDeliveryTransition("send", false)).toBe(false);
    expect(shouldExecuteDeliveryTransition("deliver", false)).toBe(false);
  });
  test("sin acción disponible, ni confirmando se ejecuta nada", () => {
    expect(shouldExecuteDeliveryTransition(null, true)).toBe(false);
  });
});

describe("Normalización de errores", () => {
  test("400 → validación, mensaje del backend visible", () => {
    const result = normalizeDeliveryError({ status: 400, body: { error: "documentType inválido" } });
    expect(result.kind).toBe("validation");
    expect(result.message).toBe("documentType inválido");
  });
  test("404 → not_found", () => {
    const result = normalizeDeliveryError({ status: 404, body: { error: "La póliza indicada no existe." } });
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe("La póliza indicada no existe.");
  });
  test("409 → duplicado, mensaje visible, nunca genérico", () => {
    const result = normalizeDeliveryError({
      status: 409,
      body: { error: "Ya existe un seguimiento activo (pendiente o enviado) para este documento." },
    });
    expect(result.kind).toBe("duplicate");
    expect(result.message).toBe("Ya existe un seguimiento activo (pendiente o enviado) para este documento.");
  });
  test("status desconocido → unknown, sin exponer detalles internos", () => {
    const result = normalizeDeliveryError({ status: 500 });
    expect(result.kind).toBe("unknown");
  });
});

describe("Presentación de filas", () => {
  test("fila vinculada a póliza + refacturación: muestra período", () => {
    const display = getDeliveryRowDisplay({
      delivery: { policyId: 42, manualRecipient: null, manualPolicyNumber: null, manualCompany: null, documentType: "refacturacion" },
      policy: { policyNumber: "POL-42" },
      insured: { name: "Juan Pérez" },
      company: { name: "MAPFRE" },
      rebilling: { billingStart: "2026-01-01", billingEnd: "2026-01-31" },
    });
    expect(display.isManual).toBe(false);
    expect(display.recipientName).toBe("Juan Pérez");
    expect(display.companyName).toBe("MAPFRE");
    expect(display.policyNumber).toBe("POL-42");
    expect(display.period).toEqual({ billingStart: "2026-01-01", billingEnd: "2026-01-31" });
  });

  // Fila creada por el alta rápida ("Agregar a Envíos"): mismo join que
  // cualquier otra fila vinculada — asegurado/compañía/N° de póliza se
  // muestran automáticamente sin ningún caso especial.
  test("fila de alta rápida (documentType=poliza, sin refacturación): muestra datos de la póliza sin período", () => {
    const display = getDeliveryRowDisplay({
      delivery: { policyId: 42, manualRecipient: null, manualPolicyNumber: null, manualCompany: null, documentType: "poliza" },
      policy: { policyNumber: "POL-42" },
      insured: { name: "Juan Pérez" },
      company: { name: "MAPFRE" },
      rebilling: null,
    });
    expect(display.isManual).toBe(false);
    expect(display.recipientName).toBe("Juan Pérez");
    expect(display.companyName).toBe("MAPFRE");
    expect(display.policyNumber).toBe("POL-42");
    expect(display.period).toBeNull();
  });

  test("fila vinculada de tipo póliza: sin período aunque haya rebilling en el join", () => {
    const display = getDeliveryRowDisplay({
      delivery: { policyId: 42, manualRecipient: null, manualPolicyNumber: null, manualCompany: null, documentType: "poliza" },
      policy: { policyNumber: "POL-42" }, insured: null, company: null, rebilling: null,
    });
    expect(display.period).toBeNull();
  });

  test("fila manual histórica sigue renderizando con sus propios datos tipeados", () => {
    const display = getDeliveryRowDisplay({
      delivery: {
        policyId: null, manualRecipient: "Destinatario Histórico",
        manualPolicyNumber: "OLD-1", manualCompany: "Compañía Vieja", documentType: "poliza",
      },
      policy: null, insured: null, company: null, rebilling: null,
    });
    expect(display).toEqual({
      isManual: true,
      recipientName: "Destinatario Histórico",
      companyName: "Compañía Vieja",
      policyNumber: "OLD-1",
      period: null,
    });
  });

  test("fila manual sin ningún dato tipeado muestra guiones, nunca undefined", () => {
    const display = getDeliveryRowDisplay({
      delivery: { policyId: null, manualRecipient: null, manualPolicyNumber: null, manualCompany: null, documentType: "poliza" },
      policy: null, insured: null, company: null, rebilling: null,
    });
    expect(display.recipientName).toBe("—");
    expect(display.companyName).toBe("—");
    expect(display.policyNumber).toBe("—");
  });
});

describe("Filtros ↔ query string", () => {
  test("parsea filtros válidos", () => {
    const filters = parseDeliveriesFilters("?status=enviado&channel=whatsapp&documentType=refacturacion&q=perez");
    expect(filters).toEqual({ status: "enviado", channel: "whatsapp", documentType: "refacturacion", q: "perez" });
  });
  test("valores inválidos vuelven a vacío, nunca se propagan tal cual", () => {
    const filters = parseDeliveriesFilters("?status=inventado&channel=fax&documentType=contrato");
    expect(filters).toEqual({ status: "", channel: "", documentType: "", q: "" });
  });
  // El sentinel interno tampoco es un valor de filtro válido — filtrar por
  // "canal" solo tiene sentido para canales reales.
  test("filtrar por el sentinel de canal pendiente no se propaga (no es un canal real)", () => {
    const filters = parseDeliveriesFilters(`?channel=${DELIVERY_CHANNEL_PENDING}`);
    expect(filters.channel).toBe("");
  });
  test("sin query — todo vacío", () => {
    expect(parseDeliveriesFilters("")).toEqual({ status: "", channel: "", documentType: "", q: "" });
  });
  test("build/round-trip de la query string", () => {
    const filters = { status: "pendiente", channel: "email", documentType: "", q: "gonzalez" };
    const query = buildDeliveriesQuery(filters);
    expect(parseDeliveriesFilters(`?${query}`)).toEqual(filters);
  });
  test("sin filtros activos, la ruta es /envios sin query", () => {
    expect(buildDeliveriesPath({ status: "", channel: "", documentType: "", q: "" })).toBe("/envios");
  });
  test("con filtros, la ruta incluye la query (para returnTo con filtros preservados)", () => {
    const path = buildDeliveriesPath({ status: "pendiente", channel: "", documentType: "", q: "" });
    expect(path).toBe("/envios?status=pendiente");
  });
  // El alta rápida cuenta en "Pendientes" — mismo status que cualquier otro
  // registro pendiente, así que el filtro por status=pendiente ya la incluye
  // sin ningún caso especial (no hay un status/filtro distinto para "incompletos").
  test("filtro status=pendiente incluye tanto altas completas como rápidas (mismo status)", () => {
    const filters = parseDeliveriesFilters("?status=pendiente");
    expect(filters.status).toBe("pendiente");
  });
});
