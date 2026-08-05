// Tests de regresión del contrato de layout de la tabla de Envíos y
// Entregas (ajuste visual: control de scroll horizontal persistente,
// columna Acciones fija, contención del scroll horizontal). Las clases se
// testean en su fuente única de verdad (table-scroll-sync.ts) y además se
// verifica que envios.tsx efectivamente las use y que el scroll horizontal
// quede contenido al listado — nunca en el contenedor de página.
//
// Reescrito 2026-08-05 tras QA visual fallido: el control anterior (riel
// "espejo" con scrollbar nativo) quedaba invisible en Chrome/Windows sin
// hover — ver diagnóstico y reemplazo por <input type="range"> en
// table-scroll-sync.ts. Este archivo agrega cobertura de visibilidad
// condicionada a overflow real y de accesibilidad del nuevo control.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/deliveries-table-layout.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIVERIES_TABLE_MIN_WIDTH_CLASS,
  DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS,
  DELIVERIES_STICKY_ACTIONS_HEADER_CLASS, DELIVERIES_STICKY_ACTIONS_CELL_CLASS,
  DELIVERIES_SCROLL_CONTROL_LABEL,
  DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS, DELIVERIES_SCROLL_CONTROL_WRAPPER_HIDDEN_CLASS,
  DELIVERIES_SCROLL_RANGE_CLASS,
} from "../table-scroll-sync";

const envíosSource = readFileSync(join(import.meta.dir, "../../pages/envios.tsx"), "utf-8");
const stylesSource = readFileSync(join(import.meta.dir, "../../styles.css"), "utf-8");

describe("contrato de estilos: columna Acciones fija", () => {
  test("la celda de Acciones queda pegada a la derecha con fondo opaco", () => {
    for (const cls of [DELIVERIES_STICKY_ACTIONS_HEADER_CLASS, DELIVERIES_STICKY_ACTIONS_CELL_CLASS]) {
      expect(cls).toContain("sticky");
      expect(cls).toContain("right-0");
      // Fondo opaco (no transparente) — evita que el contenido detrás se
      // vea a través de la columna fija al hacer scroll horizontal. También
      // es lo que distingue el solapamiento ESPERADO de un frozen column
      // (ver diagnóstico 2026-08-05: Acciones cubre Programado/Enviado/
      // Entregado en reposo, por diseño, igual que Excel/Sheets) de un
      // glitch de render con fondo transparente.
      expect(cls).toMatch(/bg-\[#0d1424\]/);
    }
  });

  test("el ancho reservado alcanza para 'Completar datos' + transición + accesos sin recortarse", () => {
    const match = DELIVERIES_STICKY_ACTIONS_HEADER_CLASS.match(/min-w-\[(\d+)px\]/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(260);
  });
});

describe("contrato de estilos: tabla con ancho mínimo legible", () => {
  test("el <table> declara un min-width para no deformar columnas/badges", () => {
    const match = DELIVERIES_TABLE_MIN_WIDTH_CLASS.match(/min-w-\[(\d+)px\]/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1000);
  });
});

describe("control de scroll: visible con overflow real, oculto sin overflow", () => {
  test("la clase 'visible' es un contenedor en pantalla (no usa hidden/display:none)", () => {
    expect(DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS).not.toMatch(/\bhidden\b/);
    expect(DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS).toMatch(/\bflex\b/);
  });

  test("la clase 'oculto' realmente oculta el control (Tailwind hidden = display:none)", () => {
    expect(DELIVERIES_SCROLL_CONTROL_WRAPPER_HIDDEN_CLASS).toBe("hidden");
  });

  test("envios.tsx elige entre ambas clases según maxScrollLeft > 0 (nunca las combina ni las hardcodea)", () => {
    expect(envíosSource).toMatch(
      /maxScrollLeft > 0 \? DELIVERIES_SCROLL_CONTROL_WRAPPER_VISIBLE_CLASS : DELIVERIES_SCROLL_CONTROL_WRAPPER_HIDDEN_CLASS/,
    );
  });
});

describe("control de scroll: rango máximo y sincronización", () => {
  test("el <input type=range> usa maxScrollLeft como max y arranca en 0", () => {
    expect(envíosSource).toMatch(/type="range"/);
    expect(envíosSource).toMatch(/max=\{maxScrollLeft\}/);
    expect(envíosSource).toMatch(/defaultValue=\{0\}/);
  });

  test("el input no es un componente controlado por React (value no está en las props) — la sincronización es imperativa vía table-scroll-sync.ts", () => {
    // Si alguien agrega `value={...}` al <input>, React empezaría a pelear
    // por el valor contra createRangeScrollSync (que escribe range.value
    // imperativamente en cada evento "scroll") y el control se trabaría.
    const inputBlockMatch = envíosSource.match(/<input\s+ref=\{rangeRef\}[\s\S]*?\/>/);
    expect(inputBlockMatch).not.toBeNull();
    expect(inputBlockMatch![0]).not.toMatch(/\bvalue=\{/);
  });

  test("el ref del <input> se conecta al hook que arma createDeliveriesTableScrollControl", () => {
    expect(envíosSource).toContain("ref={rangeRef}");
    expect(envíosSource).toContain("createDeliveriesTableScrollControl");
  });
});

describe("control de scroll: accesibilidad", () => {
  test("la etiqueta 'Desplazar tabla' está definida y no vacía", () => {
    expect(DELIVERIES_SCROLL_CONTROL_LABEL).toBe("Desplazar tabla");
  });

  test("el <input> expone aria-label y title con la misma etiqueta (perceptible para lectores de pantalla y en hover)", () => {
    expect(envíosSource).toMatch(/aria-label=\{DELIVERIES_SCROLL_CONTROL_LABEL\}/);
    expect(envíosSource).toMatch(/title=\{DELIVERIES_SCROLL_CONTROL_LABEL\}/);
  });

  test("la etiqueta visible en pantalla usa el mismo texto que aria-label/title (no queda un texto huérfano)", () => {
    expect(envíosSource).toContain("{DELIVERIES_SCROLL_CONTROL_LABEL}</span>");
  });

  test("es un <input type=range> nativo (mouse/teclado/touch funcionan sin JS adicional)", () => {
    const inputBlockMatch = envíosSource.match(/<input\s+ref=\{rangeRef\}[\s\S]*?\/>/);
    expect(inputBlockMatch).not.toBeNull();
    expect(inputBlockMatch![0]).toMatch(/type="range"/);
    expect(inputBlockMatch![0]).not.toMatch(/\bdisabled\b/);
    expect(inputBlockMatch![0]).not.toMatch(/\breadOnly\b/);
    expect(inputBlockMatch![0]).not.toMatch(/tabIndex=\{?-1\}?/);
  });
});

describe("control de scroll: no depende de scrollbar nativo autooculto", () => {
  test("el contenedor de la tabla oculta explícitamente su scrollbar nativo (evita un segundo control parcialmente invisible)", () => {
    expect(DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS).toContain("deliveries-table-scroll-container");
    expect(stylesSource).toMatch(/\.deliveries-table-scroll-container\s*\{[^}]*scrollbar-width:\s*none/);
    expect(stylesSource).toMatch(/\.deliveries-table-scroll-container::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  });

  test("el thumb y el track del control tienen estilos propios definidos (no heredan la apariencia por defecto del SO/navegador)", () => {
    expect(stylesSource).toMatch(/\.deliveries-scroll-range\s*\{[^}]*appearance:\s*none/);
    expect(stylesSource).toMatch(/::-webkit-slider-runnable-track/);
    expect(stylesSource).toMatch(/::-webkit-slider-thumb/);
    expect(stylesSource).toMatch(/::-moz-range-track/);
    expect(stylesSource).toMatch(/::-moz-range-thumb/);
  });

  test("el track tiene una pista de altura suficiente para ser perceptible (>= 6px) y fondo contrastado contra la card", () => {
    const trackMatch = stylesSource.match(/::-webkit-slider-runnable-track\s*\{([^}]*)\}/);
    expect(trackMatch).not.toBeNull();
    const heightMatch = trackMatch![1].match(/height:\s*(\d+)px/);
    expect(heightMatch).not.toBeNull();
    expect(Number(heightMatch![1])).toBeGreaterThanOrEqual(6);
    // #1f2937 (track) vs #0d1424 (fondo de la card) — colores distintos,
    // no depende de un valor "auto"/heredado que podría fundirse con el fondo.
    expect(trackMatch![1]).toMatch(/background:\s*#1f2937/);
  });
});

describe("contención del scroll horizontal al listado (nunca a toda la página)", () => {
  test("envios.tsx no declara overflow-x propio: todo el scroll horizontal viene de las clases centralizadas", () => {
    expect(envíosSource).not.toMatch(/overflow-x-(auto|scroll)/);
  });

  test("la clase centralizada del contenedor de la tabla es la única con overflow-x-auto", () => {
    expect(DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS).toContain("overflow-x-auto");
    for (const cls of [DELIVERIES_TABLE_MIN_WIDTH_CLASS, DELIVERIES_STICKY_ACTIONS_HEADER_CLASS, DELIVERIES_STICKY_ACTIONS_CELL_CLASS, DELIVERIES_SCROLL_RANGE_CLASS]) {
      expect(cls).not.toMatch(/overflow-x/);
    }
  });

  test("el contenedor raíz de la página (p-4 lg:p-8) no tiene overflow-x propio", () => {
    const rootContainerMatch = envíosSource.match(/<div className="p-4 lg:p-8[^"]*">/);
    expect(rootContainerMatch).not.toBeNull();
    expect(rootContainerMatch![0]).not.toMatch(/overflow-x/);
  });

  test("envios.tsx efectivamente usa las clases centralizadas del control y de la columna fija", () => {
    expect(envíosSource).toContain("DELIVERIES_TABLE_SCROLL_CONTAINER_CLASS");
    expect(envíosSource).toContain("DELIVERIES_STICKY_ACTIONS_HEADER_CLASS");
    expect(envíosSource).toContain("DELIVERIES_STICKY_ACTIONS_CELL_CLASS");
    expect(envíosSource).toContain("DELIVERIES_TABLE_MIN_WIDTH_CLASS");
    expect(envíosSource).toContain("DELIVERIES_SCROLL_RANGE_CLASS");
  });

  test("la tabla usa refs por callback (estado), no useRef+useEffect([]) — evita el bug de timing del QA 2026-08-05", () => {
    // El bug real: useEffect(() => {...}, []) corría antes de que el
    // <table> existiera en el DOM (montado recién tras el loading async),
    // dejaba los refs en null y nunca se reintentaba. Si alguien vuelve a
    // introducir ese patrón acá, esta aserción se rompe.
    expect(envíosSource).toContain("useLayoutEffect(() => {");
    expect(envíosSource).toMatch(/\[tableScrollEl, tableEl, rangeEl\]/);
  });
});
