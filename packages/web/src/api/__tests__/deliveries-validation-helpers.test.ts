// Tests puros de src/lib/deliveries/validation.ts — sin DB, sin app, sin
// dev.db. Complementan (no reemplazan) deliveries-endpoints.test.ts, que
// prueba el contrato HTTP real end-to-end.
import { describe, test, expect } from "bun:test";
import {
  isValidDocumentType, isValidChannel, validateDeliveryLink, hasActiveDuplicateDelivery,
  validateSendTransition, validateDeliverTransition,
  DeliveryValidationError, DeliveryStatusTransitionError, DELIVERY_CHANNEL_PENDING,
} from "../../lib/deliveries/validation";

describe("isValidDocumentType / isValidChannel", () => {
  test("aceptan los valores conocidos", () => {
    expect(isValidDocumentType("poliza")).toBe(true);
    expect(isValidDocumentType("refacturacion")).toBe(true);
    expect(isValidChannel("whatsapp")).toBe(true);
    expect(isValidChannel("email")).toBe(true);
    expect(isValidChannel("copia_cliente")).toBe(true);
    expect(isValidChannel("retiro_oficina")).toBe(true);
  });
  test("rechazan valores desconocidos", () => {
    expect(isValidDocumentType("endoso")).toBe(false);
    expect(isValidDocumentType("")).toBe(false);
    expect(isValidChannel("carta_documento")).toBe(false);
  });
});

describe("validateDeliveryLink — registro manual (policyId null)", () => {
  test("manual sin rebillingId no lanza", () => {
    expect(() => validateDeliveryLink({ policyId: null, rebillingId: null, documentType: "poliza" }, null)).not.toThrow();
  });
  test("manual con rebillingId lanza DeliveryValidationError", () => {
    expect(() => validateDeliveryLink({ policyId: null, rebillingId: 5, documentType: "poliza" }, null))
      .toThrow(DeliveryValidationError);
  });
});

describe("validateDeliveryLink — documentType inválido", () => {
  test("lanza para cualquier policyId/rebillingId", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: null, documentType: "endoso" }, null))
      .toThrow(DeliveryValidationError);
  });
});

describe("validateDeliveryLink — documentType='poliza' con policyId", () => {
  test("sin rebillingId no lanza", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: null, documentType: "poliza" }, null)).not.toThrow();
  });
  test("con rebillingId lanza (poliza no puede tener rebillingId)", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: 9, documentType: "poliza" }, { id: 9, policyId: 1 }))
      .toThrow(DeliveryValidationError);
  });
});

describe("validateDeliveryLink — documentType='refacturacion' con policyId", () => {
  test("sin rebillingId lanza (obligatorio)", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: null, documentType: "refacturacion" }, null))
      .toThrow(DeliveryValidationError);
  });
  test("con rebillingId inexistente (rebilling null) lanza", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: 9, documentType: "refacturacion" }, null))
      .toThrow(DeliveryValidationError);
  });
  test("con rebilling de OTRA póliza lanza", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: 9, documentType: "refacturacion" }, { id: 9, policyId: 2 }))
      .toThrow(DeliveryValidationError);
  });
  test("con rebilling perteneciente a la misma póliza no lanza", () => {
    expect(() => validateDeliveryLink({ policyId: 1, rebillingId: 9, documentType: "refacturacion" }, { id: 9, policyId: 1 }))
      .not.toThrow();
  });
});

function existing(over: Partial<{ id: number; policyId: number | null; rebillingId: number | null; documentType: string; status: string }> = {}) {
  return { id: 1, policyId: 100, rebillingId: null, documentType: "poliza", status: "pendiente", ...over };
}

describe("hasActiveDuplicateDelivery — documentType='poliza'", () => {
  test("true si ya hay un pendiente de la misma póliza", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ status: "pendiente" })]
    );
    expect(dup).toBe(true);
  });
  test("true si el existente está 'enviado' (también activo)", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ status: "enviado" })]
    );
    expect(dup).toBe(true);
  });
  test("false si el existente está 'entregado' (permite reenvío)", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ status: "entregado" })]
    );
    expect(dup).toBe(false);
  });
  test("false si el existente está 'realizado' (legacy, permite reenvío)", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ status: "realizado" })]
    );
    expect(dup).toBe(false);
  });
  test("false si es otra póliza", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ policyId: 200, status: "pendiente" })]
    );
    expect(dup).toBe(false);
  });
});

describe("hasActiveDuplicateDelivery — documentType='refacturacion'", () => {
  test("true si ya hay un activo con el MISMO rebillingId", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: 55, documentType: "refacturacion" },
      [existing({ documentType: "refacturacion", rebillingId: 55, status: "pendiente" })]
    );
    expect(dup).toBe(true);
  });
  test("false si es la misma póliza pero OTRA refacturación", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: 55, documentType: "refacturacion" },
      [existing({ documentType: "refacturacion", rebillingId: 77, status: "pendiente" })]
    );
    expect(dup).toBe(false);
  });
});

describe("hasActiveDuplicateDelivery — registros manuales nunca compiten", () => {
  test("candidate manual (policyId null) siempre false, sin importar lo existente", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: null, rebillingId: null, documentType: "poliza" },
      [existing({ policyId: null, status: "pendiente" })]
    );
    expect(dup).toBe(false);
  });
});

describe("hasActiveDuplicateDelivery — excludeId (edición)", () => {
  test("excluye el propio registro durante un PUT", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ id: 42, status: "pendiente" })],
      42
    );
    expect(dup).toBe(false);
  });
  test("sigue detectando OTRO registro activo aunque se excluya el propio id", () => {
    const dup = hasActiveDuplicateDelivery(
      { policyId: 100, rebillingId: null, documentType: "poliza" },
      [existing({ id: 42, status: "pendiente" }), existing({ id: 43, status: "pendiente" })],
      42
    );
    expect(dup).toBe(true);
  });
});

describe("validateSendTransition", () => {
  test("desde pendiente con canal real no lanza", () => {
    expect(() => validateSendTransition("pendiente", "whatsapp")).not.toThrow();
    expect(() => validateSendTransition("pendiente", "email")).not.toThrow();
  });
  test("desde enviado/entregado/realizado lanza DeliveryStatusTransitionError (con canal real)", () => {
    expect(() => validateSendTransition("enviado", "whatsapp")).toThrow(DeliveryStatusTransitionError);
    expect(() => validateSendTransition("entregado", "whatsapp")).toThrow(DeliveryStatusTransitionError);
    expect(() => validateSendTransition("realizado", "whatsapp")).toThrow(DeliveryStatusTransitionError);
  });
  test("desde pendiente con canal sin_definir (alta rápida sin completar) lanza", () => {
    expect(() => validateSendTransition("pendiente", DELIVERY_CHANNEL_PENDING)).toThrow(DeliveryStatusTransitionError);
  });
  test("desde pendiente con canal vacío/inválido lanza", () => {
    expect(() => validateSendTransition("pendiente", "")).toThrow(DeliveryStatusTransitionError);
    expect(() => validateSendTransition("pendiente", "fax")).toThrow(DeliveryStatusTransitionError);
  });
});

describe("validateDeliverTransition", () => {
  test("desde enviado no lanza", () => {
    expect(() => validateDeliverTransition("enviado")).not.toThrow();
  });
  test("desde pendiente lanza (no se puede saltar 'enviado')", () => {
    expect(() => validateDeliverTransition("pendiente")).toThrow(DeliveryStatusTransitionError);
  });
  test("desde entregado/realizado lanza (sin regresiones ni doble transición)", () => {
    expect(() => validateDeliverTransition("entregado")).toThrow(DeliveryStatusTransitionError);
    expect(() => validateDeliverTransition("realizado")).toThrow(DeliveryStatusTransitionError);
  });
});
