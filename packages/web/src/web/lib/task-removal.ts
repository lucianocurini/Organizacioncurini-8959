// Lógica pura de la eliminación optimista de tareas (página Tareas).
// Extraída para poder testearse sin renderizar el componente — mismo
// criterio que deliveries-form.ts / payment-splits-form.ts.
//
// Bug corregido: removeTask no verificaba r.ok ni revertía el estado ante
// un DELETE fallido, a diferencia de toggle() que sí lo hacía — una tarea
// podía desaparecer de la UI para siempre aunque el servidor nunca la
// borrara. Este módulo separa las dos mitades de esa lógica para que
// ambas queden cubiertas por tests.

export interface RemovableTask {
  id: number;
}

/** Estado optimista inmediato: la tarea desaparece antes de que la request resuelva. */
export function optimisticallyRemoveTask<T extends RemovableTask>(tasks: T[], id: number): T[] {
  return tasks.filter((t) => t.id !== id);
}

/**
 * Reconciliación tras la respuesta del DELETE. Si fue exitoso, la lista
 * optimista ya es correcta — no se toca nada más (y no afecta a ninguna
 * otra tarea de la lista). Si falló, restaura la tarea removida para no
 * dejar una eliminación fantasma.
 */
export function reconcileTaskRemoval<T extends RemovableTask>(
  optimisticTasks: T[],
  removedTask: T | undefined,
  ok: boolean
): T[] {
  if (ok || !removedTask) return optimisticTasks;
  return [...optimisticTasks, removedTask];
}

/**
 * Texto de confirmación antes de borrar, según el tipo de tarea. Una
 * recurrente corta la recurrencia desde ese mes en adelante (DELETE
 * /tasks/:id desactiva el template y oculta las instancias futuras, ver
 * schema.ts) — el texto lo dice explícitamente para que el usuario no crea
 * que solo omite el mes actual. Una tarea única es un DELETE físico simple,
 * sin esa consecuencia adicional.
 */
export function taskDeleteConfirmMessage(isRecurring: number): string {
  if (isRecurring === 1) {
    return "Esta es una tarea fija. Al eliminarla dejará de aparecer este mes y en los meses siguientes. Las tareas históricas anteriores se conservarán. ¿Confirmás?";
  }
  return "¿Eliminar esta tarea?";
}
