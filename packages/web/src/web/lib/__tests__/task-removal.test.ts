// Tests de la lógica pura de eliminación optimista de tareas (página
// Tareas) — ver diagnóstico: removeTask no verificaba r.ok ni revertía el
// estado ante un DELETE fallido.
// Ejecutar con: bun test packages/web/src/web/lib/__tests__/task-removal.test.ts
import { describe, test, expect } from "bun:test";
import { optimisticallyRemoveTask, reconcileTaskRemoval, taskDeleteConfirmMessage, type RemovableTask } from "../task-removal";

interface T extends RemovableTask {
  id: number;
  title: string;
}

const A: T = { id: 1, title: "A" };
const B: T = { id: 2, title: "B" };
const C: T = { id: 3, title: "C" };

describe("optimisticallyRemoveTask", () => {
  test("quita la tarea indicada de la lista", () => {
    expect(optimisticallyRemoveTask([A, B, C], 2)).toEqual([A, C]);
  });

  test("no afecta a las demás tareas ni su orden relativo", () => {
    const result = optimisticallyRemoveTask([A, B, C], 1);
    expect(result).toEqual([B, C]);
  });

  test("id inexistente no altera la lista", () => {
    expect(optimisticallyRemoveTask([A, B], 999)).toEqual([A, B]);
  });
});

describe("reconcileTaskRemoval — DELETE exitoso", () => {
  test("ok=true: la lista optimista se mantiene tal cual, sin restaurar nada", () => {
    const optimistic = optimisticallyRemoveTask([A, B, C], 2);
    const result = reconcileTaskRemoval(optimistic, B, true);
    expect(result).toEqual([A, C]);
  });

  test("eliminar una tarea exitosamente no afecta a las demás", () => {
    const optimistic = optimisticallyRemoveTask([A, B, C], 1);
    const result = reconcileTaskRemoval(optimistic, A, true);
    expect(result).toEqual([B, C]);
    expect(result.find((t) => t.id === B.id)).toEqual(B);
    expect(result.find((t) => t.id === C.id)).toEqual(C);
  });
});

describe("reconcileTaskRemoval — DELETE fallido (rollback)", () => {
  test("ok=false: la tarea removida se restaura a la lista", () => {
    const optimistic = optimisticallyRemoveTask([A, B, C], 2);
    const result = reconcileTaskRemoval(optimistic, B, false);
    expect(result).toContainEqual(B);
    expect(result.length).toBe(3);
  });

  test("el rollback no afecta a las demás tareas de la lista", () => {
    const optimistic = optimisticallyRemoveTask([A, B, C], 1);
    const result = reconcileTaskRemoval(optimistic, A, false);
    expect(result).toContainEqual(A);
    expect(result).toContainEqual(B);
    expect(result).toContainEqual(C);
    expect(result.length).toBe(3);
  });

  test("sin tarea removida conocida (undefined), no revienta ni inventa una fila", () => {
    const result = reconcileTaskRemoval([A, C], undefined, false);
    expect(result).toEqual([A, C]);
  });
});

describe("taskDeleteConfirmMessage — texto de confirmación distinto por tipo", () => {
  test("recurrente: menciona que corta la recurrencia desde ese mes en adelante y conserva el historial", () => {
    const msg = taskDeleteConfirmMessage(1);
    expect(msg).toContain("tarea fija");
    expect(msg).toContain("meses siguientes");
    expect(msg).toContain("histór");
  });

  test("única: confirmación simple, sin mencionar recurrencia ni historial", () => {
    const msg = taskDeleteConfirmMessage(0);
    expect(msg).not.toContain("meses siguientes");
    expect(msg).not.toContain("histór");
  });

  test("los dos textos son distintos entre sí", () => {
    expect(taskDeleteConfirmMessage(1)).not.toBe(taskDeleteConfirmMessage(0));
  });
});
