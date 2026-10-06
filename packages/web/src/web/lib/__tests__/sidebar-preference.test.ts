// Preferencia "menú lateral colapsado" (src/web/lib/sidebar-preference.ts):
// expandido por defecto y ante cualquier falla de localStorage, persistencia
// por navegador y sincronización con otras pestañas (evento "storage").
// Sin DOM. Ejecutar con: bun test packages/web/src/web/lib/__tests__/sidebar-preference.test.ts
import { describe, test, expect } from "bun:test";
import {
  createSidebarPreferenceStore, parseSidebarCollapsed, SIDEBAR_COLLAPSED_STORAGE_KEY,
  type StorageLike, type StorageEventLike,
} from "../sidebar-preference";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => { data[k] = v; },
  };
}
const throwingStorage: StorageLike = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};
function fakeWin() {
  const listeners = new Set<(e: StorageEventLike) => void>();
  return {
    addEventListener: (_t: "storage", l: (e: StorageEventLike) => void) => { listeners.add(l); },
    removeEventListener: (_t: "storage", l: (e: StorageEventLike) => void) => { listeners.delete(l); },
    dispatch: (e: StorageEventLike) => { for (const l of [...listeners]) l(e); },
    count: () => listeners.size,
  };
}

describe("parseSidebarCollapsed", () => {
  test("solo \"1\" es colapsado; ausente o inválido → expandido", () => {
    expect(parseSidebarCollapsed("1")).toBe(true);
    for (const v of [null, undefined, "", "0", "true", "yes", "collapsed", " 1", "01"]) {
      expect(parseSidebarCollapsed(v)).toBe(false);
    }
  });
});

describe("createSidebarPreferenceStore", () => {
  test("estado inicial expandido sin valor guardado", () => {
    expect(createSidebarPreferenceStore(() => memoryStorage(), fakeWin()).getSnapshot()).toBe(false);
  });

  test("lee la preferencia guardada en el primer acceso (síncrono)", () => {
    const s = createSidebarPreferenceStore(() => memoryStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: "1" }), fakeWin());
    expect(s.getSnapshot()).toBe(true);
  });

  test("valor inválido guardado → expandido", () => {
    const s = createSidebarPreferenceStore(() => memoryStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: "garbage" }), fakeWin());
    expect(s.getSnapshot()).toBe(false);
  });

  test("localStorage que falla al leer → expandido; al escribir, el cambio vale igual en la sesión", () => {
    const s = createSidebarPreferenceStore(() => throwingStorage, fakeWin());
    expect(s.getSnapshot()).toBe(false);
    expect(() => s.setCollapsed(true)).not.toThrow();
    expect(s.getSnapshot()).toBe(true);
  });

  test("acceder a localStorage puede lanzar (bloqueado) → expandido", () => {
    const s = createSidebarPreferenceStore(() => { throw new Error("SecurityError"); }, fakeWin());
    expect(s.getSnapshot()).toBe(false);
    expect(() => s.setCollapsed(true)).not.toThrow();
  });

  test("setCollapsed persiste \"1\"/\"0\" y avisa a los suscriptos una sola vez por cambio", () => {
    const storage = memoryStorage();
    const s = createSidebarPreferenceStore(() => storage, fakeWin());
    let calls = 0;
    s.subscribe(() => calls++);
    s.setCollapsed(true);
    expect(storage.data[SIDEBAR_COLLAPSED_STORAGE_KEY]).toBe("1");
    expect(s.getSnapshot()).toBe(true);
    s.setCollapsed(true);
    expect(calls).toBe(1);
    s.setCollapsed(false);
    expect(storage.data[SIDEBAR_COLLAPSED_STORAGE_KEY]).toBe("0");
    expect(calls).toBe(2);
  });

  test("otra pestaña cambia la preferencia → se sincroniza; otras claves no", () => {
    const win = fakeWin();
    const s = createSidebarPreferenceStore(() => memoryStorage(), win);
    let calls = 0;
    s.subscribe(() => calls++);
    expect(s.getSnapshot()).toBe(false);
    win.dispatch({ key: "session_id", newValue: "x" });
    expect(calls).toBe(0);
    win.dispatch({ key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: "1" });
    expect(s.getSnapshot()).toBe(true);
    expect(calls).toBe(1);
    win.dispatch({ key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: "basura" });
    expect(s.getSnapshot()).toBe(false);
    // localStorage.clear() en otra pestaña (key null) → expandido.
    win.dispatch({ key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: "1" });
    win.dispatch({ key: null, newValue: null });
    expect(s.getSnapshot()).toBe(false);
  });

  test("escucha \"storage\" solo mientras hay suscriptos (sin listeners residuales)", () => {
    const win = fakeWin();
    const s = createSidebarPreferenceStore(() => memoryStorage(), win);
    const off1 = s.subscribe(() => {});
    const off2 = s.subscribe(() => {});
    expect(win.count()).toBe(1);
    off1();
    expect(win.count()).toBe(1);
    off2();
    expect(win.count()).toBe(0);
  });
});
