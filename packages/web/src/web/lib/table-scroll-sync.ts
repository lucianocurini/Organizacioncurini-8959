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
// Sin ResizeObserver no se mide el desborde y el control queda oculto: en ese
// caso el contenedor conserva su scrollbar nativo, para que la tabla nunca
// quede sin una forma visible de desplazarse horizontalmente.
export const DELIVERIES_TABLE_SCROLL_CONTAINER_FALLBACK_CLASS = "overflow-x-auto";
export function deliveriesTableScrollContainerClass(hasResizeObserver: boolean): string {
  return hasResizeObserver ? DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS : DELIVERIES_TABLE_SCROLL_CONTAINER_FALLBACK_CLASS;
}
export const DELIVERIES_STICKY_ACTIONS_HEADER_CLASS =
  "sticky right-0 z-10 bg-[#0d1424] px-5 py-3 min-w-[260px] w-[260px] border-l border-[#1f2937]";
export const DELIVERIES_STICKY_ACTIONS_CELL_CLASS =
  "sticky right-0 z-10 bg-[#0d1424] group-hover:bg-[#1a2540] px-5 py-3 border-l border-[#1f2937] transition-colors";
export const DELIVERIES_SCROLL_CONTROL_LABEL = "Desplazar tabla";
export const DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS = "flex items-center gap-3 border-b border-[#1f2937] px-4 py-2";
export const DELIVERIES_SCROLL_CONTROL_WRAPPER_HIDDEN_CLASS = "hidden";
export const DELIVERIES_SCROLL_RANGE_CLASS = "deliveries-scroll-range flex-1";
// Modo flotante (ver computeFloatingScrollBarLayout): fijo arriba de la
// pantalla, fondo opaco y por encima de la tabla, pero debajo de modales
// (z-50) y del drawer mobile. Solo bordes laterales: el inferior ya viene de
// la clase "visible" y uno superior haría la barra flotante 1px más alta que
// el lugar que le reserva el slot (el contenido saltaría).
export const DELIVERIES_SCROLL_CONTROL_FLOATING_CLASS = "fixed z-30 bg-[#0d1424] border-x border-[#1f2937] shadow-lg shadow-black/40";

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

// ─── Control flotante ─────────────────────────────────────────────────────────
//
// El control vive en el flujo normal arriba de la tabla, así que en una tabla
// larga se iba de la pantalla al bajar. Un `position: sticky` no sirve acá:
// <main overflow-auto> (AppLayout) y la card overflow-hidden son contenedores
// de scroll que nunca scrollean (la que scrollea es la ventana), y quitarles
// el overflow cambiaría otras páginas. Por eso el MISMO <input> pasa a
// `position: fixed` arriba de la pantalla mientras la tabla sigue visible,
// alineado con el contenedor real de scroll de la tabla. Un "slot" en el flujo
// conserva su alto para que el contenido no salte.

export type FloatingScrollBarMode = "hidden" | "inline" | "floating" | "out_of_view";

export interface FloatingScrollBarLayout {
  mode: FloatingScrollBarMode;
  /** Solo en "floating": posición/ancho en px de viewport y alto reservado en el slot. */
  top: number;
  left: number;
  width: number;
  barHeight: number;
}

export interface FloatingScrollBarGeometry {
  /** Hay desborde horizontal real (maxScrollLeft > 0). */
  hasOverflow: boolean;
  /** getBoundingClientRect().top del slot (lugar del control en el flujo). */
  slotTop: number;
  /** getBoundingClientRect() del contenedor de scroll de la tabla. */
  scrollRect: { left: number; width: number; bottom: number };
  /** Alto del control. */
  barHeight: number;
  /** Borde superior donde flota (0: en escritorio no hay header fijo). */
  topOffset?: number;
}

export const HIDDEN_FLOATING_SCROLL_BAR_LAYOUT: FloatingScrollBarLayout = { mode: "hidden", top: 0, left: 0, width: 0, barHeight: 0 };

/**
 * - sin desborde → "hidden" (no se muestra);
 * - el lugar del control todavía está en pantalla (o más abajo) → "inline";
 * - ya pasó hacia arriba y debajo del control flotante sigue habiendo tabla
 *   → "floating", con left/width del contenedor de la tabla;
 * - la tabla también terminó de pasar → "out_of_view" (vuelve al flujo,
 *   fuera de pantalla — nunca queda flotando sobre otra cosa).
 */
export function computeFloatingScrollBarLayout(g: FloatingScrollBarGeometry): FloatingScrollBarLayout {
  if (!g.hasOverflow) return HIDDEN_FLOATING_SCROLL_BAR_LAYOUT;
  const top = g.topOffset ?? 0;
  const base = { top: 0, left: 0, width: 0, barHeight: 0 };
  if (g.slotTop >= top) return { mode: "inline", ...base };
  if (g.scrollRect.bottom > top + g.barHeight) {
    return {
      mode: "floating",
      top,
      left: Math.round(g.scrollRect.left),
      width: Math.round(g.scrollRect.width),
      barHeight: Math.round(g.barHeight),
    };
  }
  return { mode: "out_of_view", ...base };
}

export function sameFloatingScrollBarLayout(a: FloatingScrollBarLayout, b: FloatingScrollBarLayout): boolean {
  return a.mode === b.mode && a.top === b.top && a.left === b.left && a.width === b.width && a.barHeight === b.barHeight;
}

export interface RectElement {
  getBoundingClientRect(): { top: number; left: number; width: number; height: number; bottom: number };
}

export interface FloatingWindowLike {
  addEventListener(type: "scroll" | "resize", listener: () => void, options?: { passive?: boolean; capture?: boolean }): void;
  removeEventListener(type: "scroll" | "resize", listener: () => void, options?: { capture?: boolean }): void;
  requestAnimationFrame(cb: () => void): number;
  cancelAnimationFrame(id: number): void;
}

export interface FloatingScrollBarTrackerHandle {
  /** Recalcula ya (p. ej. cuando cambia el desborde). */
  refresh(): void;
  destroy(): void;
}

/**
 * Recalcula el layout del control con cada scroll (de cualquier contenedor,
 * en captura), resize/zoom de la ventana y cambio de tamaño del contenedor o
 * de la tabla (filtros, menú lateral colapsado). Agrupa en un frame y solo
 * avisa cuando el layout cambia — nunca dentro de un updater de React.
 */
export function createFloatingScrollBarTracker(opts: {
  slotEl: RectElement;
  barEl: RectElement;
  scrollEl: RectElement;
  contentEl: unknown;
  hasOverflow: () => boolean;
  onLayoutChange: (layout: FloatingScrollBarLayout) => void;
  win: FloatingWindowLike;
  ResizeObserverImpl: ResizeObserverCtor;
}): FloatingScrollBarTrackerHandle {
  const { slotEl, barEl, scrollEl, contentEl, hasOverflow, onLayoutChange, win, ResizeObserverImpl } = opts;
  let last: FloatingScrollBarLayout | null = null;
  let frame: number | null = null;
  let destroyed = false;

  function compute() {
    frame = null;
    if (destroyed) return;
    const slot = slotEl.getBoundingClientRect();
    const rect = scrollEl.getBoundingClientRect();
    const next = computeFloatingScrollBarLayout({
      hasOverflow: hasOverflow(),
      slotTop: slot.top,
      scrollRect: { left: rect.left, width: rect.width, bottom: rect.bottom },
      barHeight: barEl.getBoundingClientRect().height,
    });
    if (last && sameFloatingScrollBarLayout(last, next)) return;
    last = next;
    onLayoutChange(next);
  }
  function schedule() {
    if (destroyed || frame !== null) return;
    frame = win.requestAnimationFrame(compute);
  }

  win.addEventListener("scroll", schedule, { passive: true, capture: true });
  win.addEventListener("resize", schedule, { passive: true });
  const observer = new ResizeObserverImpl(schedule);
  observer.observe(scrollEl);
  observer.observe(contentEl);
  compute();

  return {
    refresh() {
      if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; }
      compute();
    },
    destroy() {
      destroyed = true;
      if (frame !== null) win.cancelAnimationFrame(frame);
      win.removeEventListener("scroll", schedule, { capture: true });
      win.removeEventListener("resize", schedule);
      observer.disconnect();
    },
  };
}
