// Tests de la sincronización pura del control de scroll horizontal
// persistente de la tabla de Envíos y Entregas (ajuste visual, sin tocar
// lógica de negocio). Reescrito 2026-08-05: el control pasó de un <div>
// "espejo" con scrollbar nativo (invisible sin hover en Chrome/Windows,
// ver diagnóstico en table-scroll-sync.ts) a un <input type="range">
// estilizado a mano, siempre visible cuando hay overflow real.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/table-scroll-sync.test.ts
import { describe, test, expect } from "bun:test";
import {
  createRangeScrollSync, createMaxScrollObserver, createDeliveriesTableScrollControl,
  type RangeInputTarget, type ScrollListenTarget, type SizedElement,
  type ResizeObserverLike, type ResizeObserverCtor,
} from "../table-scroll-sync";

// Doble mínimo del contenedor real de scroll de la tabla: scrollLeft +
// clientWidth (mutable, para simular resize) + eventos de "scroll". Dispara
// sus listeners al cambiar scrollLeft — igual que un <div> real (mismo
// criterio que las pruebas de sincronización del resto de la app).
function fakeScrollContainer(clientWidth = 1000): ScrollListenTarget & SizedElement & { listenerCount: () => number } {
  let scrollLeft = 0;
  const listeners = new Set<() => void>();
  return {
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(v: number) {
      if (v === scrollLeft) return;
      scrollLeft = v;
      for (const l of [...listeners]) l();
    },
    clientWidth,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    listenerCount() { return listeners.size; },
  };
}

// Doble mínimo de un <input type="range">: implementa la interfaz que
// consume createRangeScrollSync (value + addEventListener/removeEventListener
// de "input"), con un trigger manual `simulateUserInput` — en el DOM real,
// asignar .value por código NUNCA dispara "input" (solo la interacción del
// usuario sí), así que los tests deben disparar el evento explícitamente.
function fakeUserDrivenRangeInput(): RangeInputTarget & { listenerCount: () => number; simulateUserInput: (v: string) => void } {
  let value = "0";
  const listeners = new Set<() => void>();
  return {
    get value() { return value; },
    set value(v: string) { value = v; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    listenerCount() { return listeners.size; },
    simulateUserInput(v: string) {
      value = v;
      for (const l of [...listeners]) l();
    },
  };
}

describe("createRangeScrollSync", () => {
  test("mover el control (input del usuario) desplaza la tabla", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer();
    createRangeScrollSync(range, scrollEl);

    range.simulateUserInput("120");

    expect(scrollEl.scrollLeft).toBe(120);
  });

  test("desplazar la tabla (mouse/trackpad/touch/teclado) actualiza el control", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer();
    createRangeScrollSync(range, scrollEl);

    scrollEl.scrollLeft = 87;

    expect(range.value).toBe("87");
  });

  test("redondea scrollLeft fraccionario al reflejarlo en el control", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer();
    createRangeScrollSync(range, scrollEl);

    scrollEl.scrollLeft = 42.6;

    expect(range.value).toBe("43");
  });

  test("no entra en loop infinito ante ecos síncronos (guard anti-eco)", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer();
    createRangeScrollSync(range, scrollEl);

    let scrollListenerCalls = 0;
    scrollEl.addEventListener("scroll", () => { scrollListenerCalls++; });

    // simulateUserInput dispara "input" -> onRangeInput escribe
    // scrollEl.scrollLeft, que dispara TODOS los listeners de scrollEl
    // síncronamente: el de arriba (+1) y el propio onScroll de la
    // sincronización. El guard evita que onScroll reescriba range.value de
    // forma que dispare un nuevo "input" — acá no hay riesgo real de loop
    // porque escribir .value nunca dispara "input" en el DOM real, pero el
    // guard protege igual si algún día cambia esa asunción.
    range.simulateUserInput("50");

    expect(scrollListenerCalls).toBe(1);
    expect(scrollEl.scrollLeft).toBe(50);
    expect(range.value).toBe("50");
  });

  test("destroy() quita los listeners de ambos elementos (sin residuales)", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer();
    const handle = createRangeScrollSync(range, scrollEl);

    expect(range.listenerCount()).toBe(1);
    expect(scrollEl.listenerCount()).toBe(1);

    handle.destroy();

    expect(range.listenerCount()).toBe(0);
    expect(scrollEl.listenerCount()).toBe(0);

    // Tras destroy, ninguno de los dos lados debe seguir reaccionando.
    scrollEl.scrollLeft = 999;
    expect(range.value).toBe("0");
    range.simulateUserInput("777");
    expect(scrollEl.scrollLeft).toBe(999); // no cambió por el input post-destroy
  });
});

// Doble mínimo de ResizeObserver: captura el callback para poder dispararlo
// manualmente y así simular un resize real sin jsdom. Soporta observe()
// múltiples veces (createMaxScrollObserver observa dos targets).
class FakeResizeObserver implements ResizeObserverLike {
  static instances: FakeResizeObserver[] = [];
  targets: unknown[] = [];
  disconnected = false;
  constructor(public callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown) { this.targets.push(target); }
  disconnect() { this.disconnected = true; }
}
function fakeResizeObserverCtor() {
  FakeResizeObserver.instances = [];
  return { Ctor: FakeResizeObserver as unknown as ResizeObserverCtor, instances: FakeResizeObserver.instances };
}

describe("createMaxScrollObserver", () => {
  test("reporta maxScrollLeft inicial = scrollWidth - clientWidth", () => {
    const { Ctor } = fakeResizeObserverCtor();
    const values: number[] = [];
    createMaxScrollObserver({ clientWidth: 1000 }, { scrollWidth: 1400 }, w => values.push(w), Ctor);
    expect(values).toEqual([400]);
  });

  test("nunca reporta un valor negativo cuando el contenido entra sin overflow", () => {
    const { Ctor } = fakeResizeObserverCtor();
    const values: number[] = [];
    createMaxScrollObserver({ clientWidth: 1200 }, { scrollWidth: 900 }, w => values.push(w), Ctor);
    expect(values).toEqual([0]);
  });

  test("recalcula cuando el CONTENEDOR cambia de tamaño (resize de ventana/sidebar)", () => {
    const { Ctor, instances } = fakeResizeObserverCtor();
    const values: number[] = [];
    const scrollEl = { clientWidth: 1000 };
    createMaxScrollObserver(scrollEl, { scrollWidth: 1400 }, w => values.push(w), Ctor);

    scrollEl.clientWidth = 800;
    instances[0].callback();

    expect(values).toEqual([400, 600]);
  });

  test("recalcula cuando el CONTENIDO (<table>) cambia de tamaño", () => {
    const { Ctor, instances } = fakeResizeObserverCtor();
    const values: number[] = [];
    const contentEl = { scrollWidth: 1400 };
    createMaxScrollObserver({ clientWidth: 1000 }, contentEl, w => values.push(w), Ctor);

    contentEl.scrollWidth = 1600;
    instances[0].callback();

    expect(values).toEqual([400, 600]);
  });

  test("observa AMBOS elementos (contenedor y contenido)", () => {
    const { Ctor, instances } = fakeResizeObserverCtor();
    const scrollEl = { clientWidth: 1000 };
    const contentEl = { scrollWidth: 1400 };
    createMaxScrollObserver(scrollEl, contentEl, () => {}, Ctor);
    expect(instances[0].targets).toEqual([scrollEl, contentEl]);
  });

  test("destroy() desconecta el observer (sin residuales)", () => {
    const { Ctor, instances } = fakeResizeObserverCtor();
    const handle = createMaxScrollObserver({ clientWidth: 1000 }, { scrollWidth: 1400 }, () => {}, Ctor);
    expect(instances[0].disconnected).toBe(false);
    handle.destroy();
    expect(instances[0].disconnected).toBe(true);
  });
});

describe("createDeliveriesTableScrollControl (composición usada por el efecto de React)", () => {
  test("sincroniza scroll y recalcula el rango máximo a la vez", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer(1000);
    const { Ctor } = fakeResizeObserverCtor();
    const maxValues: number[] = [];

    createDeliveriesTableScrollControl(range, scrollEl, { scrollWidth: 1400 }, w => maxValues.push(w), Ctor);

    scrollEl.scrollLeft = 42;

    expect(range.value).toBe("42");
    expect(maxValues).toEqual([400]);
  });

  // Escenario de "montaje/desmontaje" real: simula lo que hace
  // useDeliveriesTableScrollControl en envios.tsx — setup en el efecto,
  // destroy() en su cleanup al desmontar. Verifica que un unmount no deja
  // ni el listener de "input" del control, ni el de "scroll" de la tabla,
  // ni el ResizeObserver residuales.
  test("el cleanup de unmount no deja listeners ni observers residuales", () => {
    const range = fakeUserDrivenRangeInput();
    const scrollEl = fakeScrollContainer(1000);
    const { Ctor, instances } = fakeResizeObserverCtor();

    const handle = createDeliveriesTableScrollControl(range, scrollEl, { scrollWidth: 1400 }, () => {}, Ctor);
    expect(range.listenerCount()).toBe(1);
    expect(scrollEl.listenerCount()).toBe(1);
    expect(instances[0].disconnected).toBe(false);

    handle.destroy();

    expect(range.listenerCount()).toBe(0);
    expect(scrollEl.listenerCount()).toBe(0);
    expect(instances[0].disconnected).toBe(true);

    scrollEl.scrollLeft = 500;
    expect(range.value).toBe("0");
  });
});
