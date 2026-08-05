// Lógica pura (sin React) del control de scroll horizontal persistente que
// se muestra arriba de la tabla ancha de Envíos y Entregas, sincronizado en
// ambos sentidos con el scroll real del contenedor de la tabla.
//
// Diagnóstico 2026-08-05 (Chrome/Windows, ~1365px): la primera versión de
// este control usaba un <div overflow-x-auto> "espejo" que dependía del
// scrollbar NATIVO del navegador — en Chrome/Windows esos scrollbars solo se
// pintan al pasar el mouse, así que el control quedaba invisible sin hover.
// Además, un bug de timing (useEffect con deps [] corriendo antes de que el
// <table> existiera en el DOM, montado recién tras el loading) dejaba el
// riel con scrollWidth=0 — sin overflow real, sin nada que mostrar. Se
// reemplaza por un <input type="range"> estilizado a mano (nunca depende de
// cómo el navegador decida pintar un scrollbar) — ver DELIVERIES_SCROLL_*
// más abajo. Separada de React para poder testear sincronización y cleanup
// sin montar componentes — mismo patrón que el resto de
// packages/web/src/web/lib/*.ts.

export interface ScrollListenTarget {
  scrollLeft: number;
  addEventListener(type: "scroll", listener: () => void): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

export interface RangeInputTarget {
  value: string;
  addEventListener(type: "input", listener: () => void): void;
  removeEventListener(type: "input", listener: () => void): void;
}

export interface ScrollSyncHandle {
  destroy(): void;
}

// Sincroniza el input[type=range] con el scrollLeft real del contenedor, en
// ambos sentidos, con guard anti-eco (mismo criterio que cualquier par
// sincronizado de esta app: un cambio disparado por la propia sincronización
// nunca reentra). Mover el control desplaza la tabla; desplazar la tabla
// (mouse, trackpad, touch, teclado dentro del contenedor) actualiza el
// control.
export function createRangeScrollSync(range: RangeInputTarget, scrollEl: ScrollListenTarget): ScrollSyncHandle {
  let syncing = false;

  function onRangeInput() {
    if (syncing) return;
    syncing = true;
    scrollEl.scrollLeft = Number(range.value);
    syncing = false;
  }

  function onScroll() {
    if (syncing) return;
    syncing = true;
    range.value = String(Math.round(scrollEl.scrollLeft));
    syncing = false;
  }

  range.addEventListener("input", onRangeInput);
  scrollEl.addEventListener("scroll", onScroll);

  return {
    destroy() {
      range.removeEventListener("input", onRangeInput);
      scrollEl.removeEventListener("scroll", onScroll);
    },
  };
}

export interface SizedElement {
  clientWidth: number;
}

export interface ContentElement {
  scrollWidth: number;
}

export interface ResizeObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}

export type ResizeObserverCtor = new (callback: () => void) => ResizeObserverLike;

export interface WidthObserverHandle {
  destroy(): void;
}

// Recalcula maxScrollLeft = scrollWidth del contenido - clientWidth visible,
// y lo reporta con cada cambio. Observa AMBOS elementos: el contenedor
// (cambia con el ancho de ventana/sidebar) y el <table> (cambia si el
// contenido reflowea, p.ej. datos más largos) — cualquiera de los dos puede
// mover maxScrollLeft sin que el otro cambie de tamaño.
export function createMaxScrollObserver(
  scrollEl: SizedElement,
  contentEl: ContentElement,
  onMaxScrollChange: (maxScrollLeft: number) => void,
  ResizeObserverImpl: ResizeObserverCtor,
): WidthObserverHandle {
  function recompute() {
    onMaxScrollChange(Math.max(0, contentEl.scrollWidth - scrollEl.clientWidth));
  }
  recompute();
  const observer = new ResizeObserverImpl(recompute);
  observer.observe(scrollEl);
  observer.observe(contentEl);
  return {
    destroy() {
      observer.disconnect();
    },
  };
}

// Clases Tailwind / constantes del ajuste visual de la tabla de Envíos y
// Entregas, centralizadas para que el contrato de layout (columna Acciones
// fija con fondo opaco, contención del scroll horizontal al listado, control
// de scroll siempre visible) tenga una sola fuente de verdad, testeable sin
// depender del texto exacto del JSX.
export const DELIVERIES_TABLE_MIN_WIDTH_CLASS = "w-full min-w-[1200px] text-sm";
// scrollbar nativo del contenedor deliberadamente oculto (.deliveries-table-scroll-container
// en styles.css) — el control de abajo es la única superficie de scroll
// horizontal visible; overflow-x:auto se mantiene, así que trackpad/touch/
// rueda del mouse siguen funcionando sobre la tabla en sí.
export const DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS = "overflow-x-auto deliveries-table-scroll-container";
export const DELIVERIES_STICKY_ACTIONS_HEADER_CLASS =
  "sticky right-0 z-10 bg-[#0d1424] px-5 py-3 min-w-[260px] w-[260px] border-l border-[#1f2937]";
export const DELIVERIES_STICKY_ACTIONS_CELL_CLASS =
  "sticky right-0 z-10 bg-[#0d1424] group-hover:bg-[#1a2540] px-5 py-3 border-l border-[#1f2937] transition-colors";
export const DELIVERIES_SCROLL_CONTROL_LABEL = "Desplazar tabla";
export const DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS = "flex items-center gap-3 border-b border-[#1f2937] px-4 py-2";
export const DELIVERIES_SCROLL_CONTROL_WRAPPER_HIDDEN_CLASS = "hidden";
export const DELIVERIES_SCROLL_RANGE_CLASS = "deliveries-scroll-range flex-1";

// Combina sync + observer exactamente como lo hace el efecto de React que
// las usa (useDeliveriesTableScrollControl en envios.tsx) — se testea acá,
// aislado de React, para garantizar que el cleanup de un unmount no deja
// listeners de scroll/input ni observers residuales.
export function createDeliveriesTableScrollControl(
  range: RangeInputTarget,
  scrollEl: ScrollListenTarget & SizedElement,
  contentEl: ContentElement,
  onMaxScrollChange: (maxScrollLeft: number) => void,
  ResizeObserverImpl: ResizeObserverCtor,
): ScrollSyncHandle {
  const scrollHandle = createRangeScrollSync(range, scrollEl);
  const maxHandle = createMaxScrollObserver(scrollEl, contentEl, onMaxScrollChange, ResizeObserverImpl);
  return {
    destroy() {
      scrollHandle.destroy();
      maxHandle.destroy();
    },
  };
}
