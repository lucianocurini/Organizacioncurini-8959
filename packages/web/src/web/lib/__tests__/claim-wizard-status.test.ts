// Tests de los helpers puros del wizard de siniestros (packages/web/src/web/lib/claim-wizard-status.ts).
// No usan React ni DOM — cubren el bug de QA 2026-07-24: una previa con póliza
// vinculada terminaba guardada como "en_curso" porque el checkbox "mantener
// como previa" solo se leía en el paso 1, y los pasos 2-4 pisaban el status.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/claim-wizard-status.test.ts

import { describe, test, expect } from "bun:test";
import {
  computeIsPreliminaryPath, resolveStep1Status, resolveStep2Status, resolveStep3Status,
  resolveFinishStatus, canConvertToThirdPartyClaim,
  buildClaimWizardResumeState, normalizeDateForInput, normalizeTimeForInput,
  type ClaimRecord,
} from "../claim-wizard-status";

describe("computeIsPreliminaryPath", () => {
  test("con póliza real y keepPreliminary=true: modo previa", () => {
    expect(computeIsPreliminaryPath(true, true)).toBe(true);
  });
  test("con póliza real y keepPreliminary=false: modo definitivo", () => {
    expect(computeIsPreliminaryPath(true, false)).toBe(false);
  });
  test("sin póliza real, aunque keepPreliminary=false: sigue en modo previa (no se puede finalizar sin póliza)", () => {
    expect(computeIsPreliminaryPath(false, false)).toBe(true);
  });
  test("sin póliza real y keepPreliminary=true: modo previa", () => {
    expect(computeIsPreliminaryPath(false, true)).toBe(true);
  });
});

// ─── keepPreliminary=true conserva "pendiente" en todos los pasos ──────────────

describe("modo previa (isPreliminaryPath=true): todos los pasos conservan pendiente", () => {
  test("paso 1 no pasa a nuevo", () => {
    expect(resolveStep1Status(true)).toBe("pendiente");
  });
  test("paso 2 no pasa a en_curso", () => {
    expect(resolveStep2Status(true, { hasThirdParty: true, insuredAtFault: false })).toBe("pendiente");
  });
  test("paso 2 no pasa a resuelto aunque el asegurado sea culpable", () => {
    expect(resolveStep2Status(true, { hasThirdParty: true, insuredAtFault: true })).toBe("pendiente");
  });
  test("paso 3 (continuar) no pasa a reclamo_tercero", () => {
    expect(resolveStep3Status(true, { skip: false })).toBe("pendiente");
  });
  test("paso 3 (saltar) no pasa a en_curso", () => {
    expect(resolveStep3Status(true, { skip: true })).toBe("pendiente");
  });
  test("paso 4 no pasa a resuelto", () => {
    expect(resolveFinishStatus(true, { resolved: true })).toBe("pendiente");
  });
  test("paso 4 no pasa a en_curso", () => {
    expect(resolveFinishStatus(true, { resolved: false })).toBe("pendiente");
  });
});

// ─── keepPreliminary=false conserva las transiciones normales existentes ───────

describe("modo definitivo (isPreliminaryPath=false): transiciones existentes sin cambios", () => {
  test("paso 1 pasa a nuevo", () => {
    expect(resolveStep1Status(false)).toBe("nuevo");
  });
  test("paso 2 pasa a en_curso sin tercero culpable", () => {
    expect(resolveStep2Status(false, { hasThirdParty: true, insuredAtFault: false })).toBe("en_curso");
  });
  test("paso 2 pasa a resuelto si el asegurado es culpable", () => {
    expect(resolveStep2Status(false, { hasThirdParty: true, insuredAtFault: true })).toBe("resuelto");
  });
  test("paso 2 pasa a en_curso sin datos de tercero (no automotor/motovehículo)", () => {
    expect(resolveStep2Status(false, { hasThirdParty: false, insuredAtFault: false })).toBe("en_curso");
  });
  test("paso 3 (continuar) pasa a reclamo_tercero", () => {
    expect(resolveStep3Status(false, { skip: false })).toBe("reclamo_tercero");
  });
  test("paso 3 (saltar) pasa a en_curso", () => {
    expect(resolveStep3Status(false, { skip: true })).toBe("en_curso");
  });
  test("paso 4 pasa a resuelto al confirmar resolución", () => {
    expect(resolveFinishStatus(false, { resolved: true })).toBe("resuelto");
  });
  test("paso 4 pasa a en_curso al dejar en trámite", () => {
    expect(resolveFinishStatus(false, { resolved: false })).toBe("en_curso");
  });
});

// ─── Finalización sin póliza real queda bloqueada ──────────────────────────────

describe("finalización sin policyId real", () => {
  test("aunque el usuario desmarque keepPreliminary, sin póliza real el paso 1 sigue en pendiente", () => {
    const isPreliminaryPath = computeIsPreliminaryPath(/* hasRealPolicy */ false, /* keepPreliminary */ false);
    expect(resolveStep1Status(isPreliminaryPath)).toBe("pendiente");
  });
  test("sin póliza real, el paso 2 tampoco puede pasar a en_curso", () => {
    const isPreliminaryPath = computeIsPreliminaryPath(false, false);
    expect(resolveStep2Status(isPreliminaryPath, { hasThirdParty: false, insuredAtFault: false })).toBe("pendiente");
  });
});

// ─── Normalización de fecha/hora para <input type="date"/"time"> ──────────────

describe("normalizeDateForInput", () => {
  test("fecha ya en formato YYYY-MM-DD: se devuelve sin cambios", () => {
    expect(normalizeDateForInput("2026-07-08")).toBe("2026-07-08");
  });
  test("datetime completo (con horario): se recorta a la parte de fecha, sin pasar por Date()", () => {
    expect(normalizeDateForInput("2026-07-08T00:00:00.000Z")).toBe("2026-07-08");
  });
  test("null/undefined/vacío: cadena vacía", () => {
    expect(normalizeDateForInput(null)).toBe("");
    expect(normalizeDateForInput(undefined)).toBe("");
    expect(normalizeDateForInput("")).toBe("");
  });
  test("formato irreconocible: cadena vacía en vez de un value inválido para el input", () => {
    expect(normalizeDateForInput("08/07/2026")).toBe("");
  });
});

describe("normalizeTimeForInput", () => {
  test("hora ya en formato HH:mm: se devuelve sin cambios", () => {
    expect(normalizeTimeForInput("16:00")).toBe("16:00");
  });
  test("hora con segundos (HH:mm:ss): se recorta a HH:mm", () => {
    expect(normalizeTimeForInput("16:00:00")).toBe("16:00");
  });
  test("null/undefined/vacío: cadena vacía", () => {
    expect(normalizeTimeForInput(null)).toBe("");
    expect(normalizeTimeForInput(undefined)).toBe("");
    expect(normalizeTimeForInput("")).toBe("");
  });
});

// ─── Reapertura de una previa ("Completar siniestro" / "Ingresar siniestro") ──

function claim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimNumber: null, manualInsured: null, manualCompany: null, manualPolicyNumber: null,
    manualPolicyType: null, manualNotes: null, incidentDate: null, incidentTime: null,
    incidentLocation: null, incidentDescription: null, damages: null, thirdPartyName: null,
    thirdPartyDni: null, thirdPartyPhone: null, thirdPartyVehiclePlate: null, thirdPartyVehicleBrand: null,
    thirdPartyVehicleModel: null, thirdPartyInsurer: null, thirdPartyPolicyNumber: null,
    claimFiled: 0, claimFiledDate: null, claimCompany: null, claimNumberThird: null, claimNotes: null,
    ...overrides,
  };
}

describe("buildClaimWizardResumeState", () => {
  test("previa con póliza real: arranca en el paso 2", () => {
    const state = buildClaimWizardResumeState(claim(), /* hasRealPolicy */ true);
    expect(state.initialStep).toBe(2);
  });
  test("previa sin póliza real: arranca en el paso 1, en modo búsqueda", () => {
    const state = buildClaimWizardResumeState(claim(), /* hasRealPolicy */ false);
    expect(state.initialStep).toBe(1);
    expect(state.initialManualMode).toBe(false);
  });
  test("sin claim (alta nueva, prefill undefined): estado vacío, arranca en el paso 1", () => {
    const state = buildClaimWizardResumeState(undefined, false);
    expect(state.initialStep).toBe(1);
    expect(state.incidentDate).toBe("");
    expect(state.thirdPartyName).toBe("");
    expect(state.claimFiled).toBe(false);
  });

  test("fecha y hora existentes se precargan (caso siniestro #94 del bug de QA)", () => {
    const state = buildClaimWizardResumeState(claim({ incidentDate: "2026-07-08", incidentTime: "16:00" }), true);
    expect(state.incidentDate).toBe("2026-07-08");
    expect(state.incidentTime).toBe("16:00");
  });
  test("fecha/hora normalizadas al precargar (datetime completo y hora con segundos)", () => {
    const state = buildClaimWizardResumeState(
      claim({ incidentDate: "2026-07-08T00:00:00.000Z", incidentTime: "16:00:00" }), true
    );
    expect(state.incidentDate).toBe("2026-07-08");
    expect(state.incidentTime).toBe("16:00");
  });

  test("datos de todos los pasos (2 y 3) se precargan desde el claim existente", () => {
    const state = buildClaimWizardResumeState(claim({
      claimNumber: "SIN-001",
      incidentLocation: "Av. Siempreviva 742",
      incidentDescription: "Choque en cruce",
      damages: "Paragolpes delantero",
      thirdPartyName: "Juan Pérez",
      thirdPartyDni: "25123456",
      thirdPartyPhone: "011-4567-8901",
      thirdPartyVehiclePlate: "AB123CD",
      thirdPartyVehicleBrand: "Ford",
      thirdPartyVehicleModel: "Focus",
      thirdPartyInsurer: "La Segunda",
      thirdPartyPolicyNumber: "TP-999",
      claimFiled: 1,
      claimFiledDate: "2026-07-10",
      claimCompany: "La Segunda",
      claimNumberThird: "EXP-123",
      claimNotes: "Reclamo presentado por el asegurado",
    }), true);
    expect(state).toMatchObject({
      claimNumber: "SIN-001",
      incidentLocation: "Av. Siempreviva 742",
      incidentDescription: "Choque en cruce",
      damages: "Paragolpes delantero",
      thirdPartyName: "Juan Pérez",
      thirdPartyDni: "25123456",
      thirdPartyPhone: "011-4567-8901",
      thirdPartyVehiclePlate: "AB123CD",
      thirdPartyVehicleBrand: "Ford",
      thirdPartyVehicleModel: "Focus",
      thirdPartyInsurer: "La Segunda",
      thirdPartyPolicyNumber: "TP-999",
      claimFiled: true,
      claimFiledDate: "2026-07-10",
      claimCompany: "La Segunda",
      claimNumberThird: "EXP-123",
      claimNotes: "Reclamo presentado por el asegurado",
    });
  });

  test("datos manuales (previa sin póliza) también se precargan", () => {
    const state = buildClaimWizardResumeState(claim({
      manualInsured: "Ana Gómez", manualCompany: "Sancor", manualPolicyNumber: "APX-1",
      manualPolicyType: "automotor", manualNotes: "Falta confirmar póliza",
    }), false);
    expect(state.manualInsured).toBe("Ana Gómez");
    expect(state.manualCompany).toBe("Sancor");
    expect(state.manualPolicyNumber).toBe("APX-1");
    expect(state.manualPolicyType).toBe("automotor");
    expect(state.manualNotes).toBe("Falta confirmar póliza");
  });

  test("valores null del claim permanecen vacíos (nunca 'null' como string ni undefined)", () => {
    const state = buildClaimWizardResumeState(claim(), true);
    expect(state.incidentDate).toBe("");
    expect(state.incidentTime).toBe("");
    expect(state.incidentLocation).toBe("");
    expect(state.thirdPartyName).toBe("");
    expect(state.claimNotes).toBe("");
    expect(state.claimFiled).toBe(false);
  });

  test("claimFiled=0/1 (columna integer) se normaliza a boolean", () => {
    expect(buildClaimWizardResumeState(claim({ claimFiled: 0 }), true).claimFiled).toBe(false);
    expect(buildClaimWizardResumeState(claim({ claimFiled: 1 }), true).claimFiled).toBe(true);
  });

  // Abrir el wizard (reapertura) solo LEE el claim para armar el estado local del
  // formulario — buildClaimWizardResumeState no llama a la API ni devuelve ningún
  // campo "status": no hay forma de que abrir el wizard cambie el status por sí
  // solo (eso solo ocurre al ejecutar una acción explícita: Continuar, Guardar
  // previa y salir, etc., que sí pasan por resolveStepXStatus).
  test("reapertura no cambia status: el estado hidratado no incluye ningún campo status", () => {
    const state = buildClaimWizardResumeState(claim({ incidentDate: "2026-07-08" }), true);
    expect(state).not.toHaveProperty("status");
  });

  // Guardar desde un paso (p.ej. paso 2) siempre parte de un estado ya hidratado
  // con TODOS los campos del claim, no solo los del paso que se está editando —
  // por eso un PUT posterior nunca puede pisar con vacío los campos de otros
  // pasos que el usuario no tocó (el bug que reportó QA con el siniestro #94).
  test("guardar un paso no elimina datos de otros pasos: el estado hidratado trae completos los campos del paso 2 y del paso 3 a la vez", () => {
    const state = buildClaimWizardResumeState(claim({
      incidentDate: "2026-07-08", incidentTime: "16:00", incidentLocation: "Ruta 2 km 100",
      claimFiled: 1, claimCompany: "La Segunda", claimNotes: "Reclamo en curso",
    }), true);
    // Los campos del paso 2 (fecha/hora/lugar) y del paso 3 (reclamo) conviven
    // en el mismo estado inicial — nada se resetea a "" solo por reabrir en el paso 2.
    expect(state.incidentDate).toBe("2026-07-08");
    expect(state.incidentTime).toBe("16:00");
    expect(state.incidentLocation).toBe("Ruta 2 km 100");
    expect(state.claimFiled).toBe(true);
    expect(state.claimCompany).toBe("La Segunda");
    expect(state.claimNotes).toBe("Reclamo en curso");
  });
});

// ─── "Convertir en reclamo de tercero" nunca aplica a una previa ───────────────

describe("canConvertToThirdPartyClaim", () => {
  test("no aplica a un siniestro pendiente (previa)", () => {
    expect(canConvertToThirdPartyClaim("pendiente")).toBe(false);
  });
  test("no aplica a nuevo, reclamo_tercero ni resuelto", () => {
    expect(canConvertToThirdPartyClaim("nuevo")).toBe(false);
    expect(canConvertToThirdPartyClaim("reclamo_tercero")).toBe(false);
    expect(canConvertToThirdPartyClaim("resuelto")).toBe(false);
  });
  test("aplica únicamente a en_curso", () => {
    expect(canConvertToThirdPartyClaim("en_curso")).toBe(true);
  });
});
