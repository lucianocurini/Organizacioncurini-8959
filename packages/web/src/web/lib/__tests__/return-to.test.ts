// Tests de validación de returnTo (navegación Reporte mensual ↔ Pólizas).
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/return-to.test.ts
import { describe, test, expect } from "bun:test";
import { isSafeReturnTo } from "../utils";

describe("isSafeReturnTo — Caso A / rutas internas válidas", () => {
  test("acepta /reporte-mes con query string completa", () => {
    expect(isSafeReturnTo("/reporte-mes?month=2026-07&companyId=3&movementType=rebilling&rebillingType=prorroga&q=123")).toBe(true);
  });
  test("acepta /reporte-mes sin query", () => {
    expect(isSafeReturnTo("/reporte-mes")).toBe(true);
  });
  test("acepta /polizas y /polizas/:id", () => {
    expect(isSafeReturnTo("/polizas")).toBe(true);
    expect(isSafeReturnTo("/polizas/123")).toBe(true);
  });
  test("acepta /polizas con filtros, orden y página (listado general)", () => {
    expect(isSafeReturnTo("/polizas?q=perez&type=automotor&status=activa&sortBy=insured&sortOrder=asc&page=2")).toBe(true);
  });
});

describe("isSafeReturnTo — Caso C (URL externa / maliciosa se rechaza)", () => {
  test("rechaza URL absoluta externa", () => {
    expect(isSafeReturnTo("https://sitio-malicioso.com")).toBe(false);
  });
  test("rechaza protocol-relative (//host)", () => {
    expect(isSafeReturnTo("//sitio-malicioso.com")).toBe(false);
  });
  test("rechaza backslash-relative (browsers lo tratan como protocol-relative)", () => {
    expect(isSafeReturnTo("/\\sitio-malicioso.com")).toBe(false);
  });
  test("rechaza esquemas no-http", () => {
    expect(isSafeReturnTo("javascript:alert(1)")).toBe(false);
  });
  test("rechaza rutas que solo empiezan igual pero no son el prefijo real", () => {
    expect(isSafeReturnTo("/polizasmalicioso")).toBe(false);
    expect(isSafeReturnTo("/reporte-mesevil")).toBe(false);
  });
  test("rechaza vacío / null / undefined", () => {
    expect(isSafeReturnTo("")).toBe(false);
    expect(isSafeReturnTo(null)).toBe(false);
    expect(isSafeReturnTo(undefined)).toBe(false);
  });
  test("rechaza rutas internas fuera de la allowlist", () => {
    expect(isSafeReturnTo("/dashboard")).toBe(false);
    expect(isSafeReturnTo("/cobranzas")).toBe(false);
  });
});
