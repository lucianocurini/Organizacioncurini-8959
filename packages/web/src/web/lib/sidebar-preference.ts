// Preferencia "menú lateral colapsado" (solo escritorio), guardada por
// navegador en localStorage.
//
// - Estado inicial expandido. Un valor ausente, inválido o un localStorage
//   que falla (modo privado, cuota, bloqueado) también deja el menú
//   expandido.
// - Se lee de forma SÍNCRONA en el primer render (useSyncExternalStore): la
//   app es una SPA sin SSR, así que no hay hidratación, y AppLayout se monta
//   en cada página sin parpadear expandido→colapsado al navegar.
// - Se guarda también en memoria: si escribir en localStorage falla, el
//   botón sigue funcionando durante la sesión.
// - Otra pestaña/ventana de la app que cambie la preferencia avisa por el
//   evento "storage"; todas las instancias de esta pestaña comparten el store.

import { useSyncExternalStore } from "react";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "organizacion-curini:sidebar-collapsed";
const COLLAPSED = "1";
const EXPANDED = "0";

/** Solo "1" significa colapsado; cualquier otro valor (o ninguno) es expandido. */
export function parseSidebarCollapsed(raw: string | null | undefined): boolean {
  return raw === COLLAPSED;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StorageEventLike {
  key: string | null;
  newValue: string | null;
}

export interface WindowLike {
  addEventListener(type: "storage", listener: (e: StorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (e: StorageEventLike) => void): void;
}

export interface SidebarPreferenceStore {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
  setCollapsed(collapsed: boolean): void;
}

export function createSidebarPreferenceStore(
  getStorage: () => StorageLike | null | undefined,
  win: WindowLike | null | undefined,
): SidebarPreferenceStore {
  let current: boolean | null = null;
  const listeners = new Set<() => void>();

  function read(): boolean {
    try {
      return parseSidebarCollapsed(getStorage()?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY));
    } catch {
      return false;
    }
  }
  function emit() {
    for (const l of [...listeners]) l();
  }
  function onStorage(e: StorageEventLike) {
    // key null = localStorage.clear() en otra pestaña → vuelve a expandido.
    if (e.key !== null && e.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return;
    const next = parseSidebarCollapsed(e.newValue);
    if (next === current) return;
    current = next;
    emit();
  }

  return {
    getSnapshot() {
      if (current === null) current = read();
      return current;
    },
    subscribe(listener) {
      if (listeners.size === 0) win?.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win?.removeEventListener("storage", onStorage);
      };
    },
    setCollapsed(collapsed) {
      try {
        getStorage()?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? COLLAPSED : EXPANDED);
      } catch {
        // Sin persistencia: el cambio vale igual para esta sesión.
      }
      if (current === collapsed) return;
      current = collapsed;
      emit();
    },
  };
}

const sidebarPreferenceStore = createSidebarPreferenceStore(
  () => (typeof window !== "undefined" ? window.localStorage : null),
  typeof window !== "undefined" ? (window as unknown as WindowLike) : null,
);

export function useSidebarCollapsed(store: SidebarPreferenceStore = sidebarPreferenceStore): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
  return [collapsed, store.setCollapsed];
}
