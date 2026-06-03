import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { CheckCircle2, Circle, Plus, Trash2, Settings, X, ChevronLeft, ChevronRight, Pencil, RefreshCw, ListChecks, Lock } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

interface TaskTemplate {
  id: number;
  title: string;
  description: string | null;
  dayOfMonth: number | null;
  order: number;
  isAdminOnly: number;
}

interface Task {
  id: number;
  templateId: number | null;
  monthYear: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: string;
  isRecurring: number;
  isAdminOnly: number;
}

function sessionId() {
  return localStorage.getItem("session_id") || "";
}

function headers() {
  return { "Content-Type": "application/json", "x-session-id": sessionId() };
}

const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function fmtMonth(ym: string) {
  const parts = ym.split("-");
  return MONTHS[parseInt(parts[1], 10) - 1] + " " + parts[0];
}

function fmtDate(d: string) {
  if (!d) return "";
  const parts = d.split("-");
  return parts[2] + "/" + parts[1] + "/" + parts[0];
}

function prevMonth(ym: string) {
  const y = parseInt(ym.split("-")[0], 10);
  const m = parseInt(ym.split("-")[1], 10);
  const d = new Date(y, m - 2, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function nextMonth(ym: string) {
  const y = parseInt(ym.split("-")[0], 10);
  const m = parseInt(ym.split("-")[1], 10);
  const d = new Date(y, m, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function todayYM() {
  const n = new Date();
  return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
}

export default function Tareas() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [month, setMonth] = useState(todayYM());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  // Add unique task form
  const [addingTask, setAddingTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newAdminOnly, setNewAdminOnly] = useState(false);

  // Add template form
  const [addingTpl, setAddingTpl] = useState(false);
  const [newTplTitle, setNewTplTitle] = useState("");
  const [newTplDesc, setNewTplDesc] = useState("");
  const [newTplDay, setNewTplDay] = useState("");
  const [newTplAdminOnly, setNewTplAdminOnly] = useState(false);

  // Edit template
  const [editTplId, setEditTplId] = useState<number | null>(null);
  const [editTplTitle, setEditTplTitle] = useState("");
  const [editTplDesc, setEditTplDesc] = useState("");
  const [editTplDay, setEditTplDay] = useState("");
  const [editTplAdminOnly, setEditTplAdminOnly] = useState(false);

  async function loadTasks(m: string) {
    setLoading(true);
    try {
      const r = await fetch("/api/tasks?month=" + m, { headers: headers() });
      const d = await r.json();
      setTasks(Array.isArray(d) ? d : []);
    } catch {
      toast.error("Error al cargar tareas");
    }
    setLoading(false);
  }

  async function loadTemplates() {
    try {
      const r = await fetch("/api/task-templates", { headers: headers() });
      const d = await r.json();
      setTemplates(Array.isArray(d) ? d : []);
    } catch {
      // ignore
    }
  }

  useEffect(() => { loadTasks(month); }, [month]);
  useEffect(() => { loadTemplates(); }, []);

  async function toggle(task: Task) {
    const next = task.status === "pendiente" ? "realizada" : "pendiente";
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: next } : t));
    try {
      await fetch("/api/tasks/" + task.id, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ status: next }),
      });
    } catch {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: task.status } : t));
    }
  }

  async function removeTask(id: number) {
    setTasks(prev => prev.filter(t => t.id !== id));
    await fetch("/api/tasks/" + id, { method: "DELETE", headers: headers() });
  }

  async function addTask() {
    if (!newTitle.trim()) return;
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ monthYear: month, title: newTitle.trim(), description: newDesc.trim() || null, dueDate: newDate || null, isAdminOnly: newAdminOnly }),
      });
      if (!r.ok) { toast.error("Error al agregar tarea"); return; }
      const t = await r.json();
      setTasks(prev => [...prev, t]);
      setNewTitle(""); setNewDesc(""); setNewDate(""); setNewAdminOnly(false); setAddingTask(false);
      toast.success("Tarea agregada");
    } catch {
      toast.error("Error al agregar tarea");
    }
  }

  async function addTemplate() {
    if (!newTplTitle.trim()) return;
    const day = newTplDay ? parseInt(newTplDay, 10) : null;
    if (day !== null && (day < 1 || day > 28)) { toast.error("El día debe ser entre 1 y 28"); return; }
    const r = await fetch("/api/task-templates", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: newTplTitle.trim(), description: newTplDesc.trim() || null, dayOfMonth: day, isAdminOnly: newTplAdminOnly }),
    });
    const t = await r.json();
    setTemplates(prev => [...prev, t]);
    setNewTplTitle(""); setNewTplDesc(""); setNewTplDay(""); setNewTplAdminOnly(false); setAddingTpl(false);
    toast.success("Tarea fija creada");
    loadTasks(month);
  }

  async function saveTemplate(id: number) {
    if (!editTplTitle.trim()) return;
    const day = editTplDay ? parseInt(editTplDay, 10) : null;
    if (day !== null && (day < 1 || day > 28)) { toast.error("El día debe ser entre 1 y 28"); return; }
    const r = await fetch("/api/task-templates/" + id, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ title: editTplTitle.trim(), description: editTplDesc.trim() || null, dayOfMonth: day, isAdminOnly: editTplAdminOnly }),
    });
    const t = await r.json();
    setTemplates(prev => prev.map(x => x.id === id ? t : x));
    setEditTplId(null);
  }

  async function removeTemplate(id: number) {
    setTemplates(prev => prev.filter(t => t.id !== id));
    await fetch("/api/task-templates/" + id, { method: "DELETE", headers: headers() });
    toast.success("Eliminada");
    loadTasks(month);
  }

  const recurring = tasks.filter(t => t.isRecurring === 1);
  const unique = tasks.filter(t => t.isRecurring === 0);

  // Sort by dueDate then createdAt
  const sortByDate = (a: Task, b: Task) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  };

  const sortedRecurring = [...recurring].sort(sortByDate);
  const sortedUnique = [...unique].sort(sortByDate);
  const done = tasks.filter(t => t.status === "realizada").length;

  return (
    <AppLayout>
      <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
          <div>
            <h1 style={{ color: "white", fontSize: "24px", fontWeight: 700, margin: 0, fontFamily: "Syne, sans-serif" }}>Tareas</h1>
            <p style={{ color: "#6b7280", fontSize: "13px", margin: "4px 0 0 0" }}>
              {tasks.length > 0 ? done + " de " + tasks.length + " realizadas" : "Sin tareas para este mes"}
            </p>
          </div>
          <button
            onClick={() => setShowConfig(!showConfig)}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "8px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500,
              background: showConfig ? "#2563eb" : "#1a2540", color: showConfig ? "white" : "#9ca3af"
            }}
          >
            <Settings size={15} />
            Tareas Fijas
          </button>
        </div>

        {/* Month nav */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
          <button onClick={() => setMonth(prevMonth(month))} style={{ background: "#1a2540", border: "none", borderRadius: "8px", padding: "8px", cursor: "pointer", color: "#9ca3af" }}>
            <ChevronLeft size={16} />
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <span style={{ color: "white", fontWeight: 600, fontSize: "15px" }}>{fmtMonth(month)}</span>
            {month !== todayYM() && (
              <button onClick={() => setMonth(todayYM())} style={{ marginLeft: "8px", background: "none", border: "none", color: "#60a5fa", fontSize: "12px", cursor: "pointer" }}>
                Hoy
              </button>
            )}
          </div>
          <button onClick={() => setMonth(nextMonth(month))} style={{ background: "#1a2540", border: "none", borderRadius: "8px", padding: "8px", cursor: "pointer", color: "#9ca3af" }}>
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Progress */}
        {tasks.length > 0 && (
          <div style={{ height: "4px", background: "#1a2540", borderRadius: "4px", marginBottom: "24px", overflow: "hidden" }}>
            <div style={{ height: "100%", background: "linear-gradient(to right, #2563eb, #60a5fa)", borderRadius: "4px", width: ((done / tasks.length) * 100) + "%", transition: "width 0.4s" }} />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>

          {/* Recurring */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <RefreshCw size={14} color="#60a5fa" />
              <span style={{ color: "#9ca3af", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Mensuales Fijas</span>
              <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: "11px" }}>
                {sortedRecurring.filter(t => t.status === "realizada").length}/{sortedRecurring.length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {loading ? (
                [1,2,3].map(i => <div key={i} style={{ height: "56px", background: "#1a2540", borderRadius: "12px" }} />)
              ) : sortedRecurring.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center", color: "#6b7280", fontSize: "13px", background: "#111827", borderRadius: "12px", border: "1px dashed #1f2937" }}>
                  Sin tareas fijas configuradas.
                  <br />
                  <button onClick={() => setShowConfig(true)} style={{ color: "#60a5fa", background: "none", border: "none", cursor: "pointer", marginTop: "4px", fontSize: "13px" }}>
                    Configurar →
                  </button>
                </div>
              ) : sortedRecurring.map(t => (
                <TaskRow key={t.id} task={t} onToggle={toggle} onDelete={removeTask} />
              ))}
            </div>
          </div>

          {/* Unique */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <ListChecks size={14} color="#a78bfa" />
              <span style={{ color: "#9ca3af", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Tareas Únicas</span>
              <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: "11px" }}>
                {sortedUnique.filter(t => t.status === "realizada").length}/{sortedUnique.length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {loading ? (
                [1,2].map(i => <div key={i} style={{ height: "56px", background: "#1a2540", borderRadius: "12px" }} />)
              ) : (
                <>
                  {sortedUnique.map(t => (
                    <TaskRow key={t.id} task={t} onToggle={toggle} onDelete={removeTask} />
                  ))}
                  {addingTask ? (
                    <div style={{ background: "#111827", border: "1px solid #253050", borderRadius: "12px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <input
                        autoFocus
                        placeholder="Título de la tarea"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") addTask(); if (e.key === "Escape") setAddingTask(false); }}
                        style={{ background: "#0a0f1e", border: "1px solid #1f2937", borderRadius: "8px", padding: "8px 12px", color: "white", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                      />
                      <input
                        placeholder="Descripción (opcional)"
                        value={newDesc}
                        onChange={e => setNewDesc(e.target.value)}
                        style={{ background: "#0a0f1e", border: "1px solid #1f2937", borderRadius: "8px", padding: "8px 12px", color: "#9ca3af", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                      />
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <label style={{ color: "#6b7280", fontSize: "11px" }}>Fecha (opcional)</label>
                        <input
                          type="date"
                          value={newDate}
                          onChange={e => setNewDate(e.target.value)}
                          style={{ background: "#0a0f1e", border: "1px solid #1f2937", borderRadius: "8px", padding: "8px 12px", color: "#9ca3af", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box", colorScheme: "dark" }}
                        />
                      </div>
                      {isAdmin && (
                        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                          <div
                            onClick={() => setNewAdminOnly(v => !v)}
                            style={{ width: "36px", height: "20px", borderRadius: "10px", background: newAdminOnly ? "#7c3aed" : "#374151", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
                          >
                            <div style={{ position: "absolute", top: "2px", left: newAdminOnly ? "18px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
                          </div>
                          <span style={{ fontSize: "12px", color: newAdminOnly ? "#a78bfa" : "#6b7280", display: "flex", alignItems: "center", gap: "4px" }}>
                            <Lock size={11} /> Solo visible para admin
                          </span>
                        </label>
                      )}
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button onClick={addTask} style={{ flex: 1, padding: "7px", background: "#7c3aed", border: "none", borderRadius: "8px", color: "white", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>
                          Agregar
                        </button>
                        <button onClick={() => { setAddingTask(false); setNewTitle(""); setNewDesc(""); setNewDate(""); setNewAdminOnly(false); }} style={{ padding: "7px 12px", background: "#1a2540", border: "none", borderRadius: "8px", color: "#9ca3af", fontSize: "12px", cursor: "pointer" }}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingTask(true)}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "12px", borderRadius: "12px", border: "1px dashed #253050", background: "none", color: "#6b7280", fontSize: "13px", cursor: "pointer" }}
                    >
                      <Plus size={15} />
                      Agregar tarea única
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Config panel */}
        {showConfig && (
          <div style={{ marginTop: "32px", background: "#111827", border: "1px solid #1f2937", borderRadius: "16px", padding: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Settings size={15} color="#60a5fa" />
                <span style={{ color: "white", fontWeight: 600, fontSize: "14px" }}>Tareas Fijas Mensuales</span>
              </div>
              <button onClick={() => setShowConfig(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280" }}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "#6b7280", fontSize: "12px", marginBottom: "16px", marginTop: 0 }}>
              Se generan automáticamente cada mes.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
              {templates.length === 0 && (
                <p style={{ color: "#6b7280", fontSize: "13px", textAlign: "center", padding: "16px 0" }}>Sin tareas fijas aún.</p>
              )}
              {templates.map(tpl => (
                <div key={tpl.id} style={{ display: "flex", alignItems: "flex-start", gap: "12px", background: "#0d1424", borderRadius: "10px", padding: "12px" }}>
                  {editTplId === tpl.id ? (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
                      <input
                        autoFocus
                        value={editTplTitle}
                        onChange={e => setEditTplTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveTemplate(tpl.id); if (e.key === "Escape") setEditTplId(null); }}
                        style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "6px 10px", color: "white", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                      />
                      <input
                        placeholder="Descripción (opcional)"
                        value={editTplDesc}
                        onChange={e => setEditTplDesc(e.target.value)}
                        style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "6px 10px", color: "#9ca3af", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                      />
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ color: "#6b7280", fontSize: "12px", whiteSpace: "nowrap" }}>Día del mes:</span>
                        <input
                          type="number"
                          min={1} max={28}
                          placeholder="1-28"
                          value={editTplDay}
                          onChange={e => setEditTplDay(e.target.value)}
                          style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "6px 10px", color: "#f59e0b", fontSize: "13px", outline: "none", width: "80px", boxSizing: "border-box" }}
                        />
                        <span style={{ color: "#4b5563", fontSize: "11px" }}>de cada mes (1-28)</span>
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                        <div
                          onClick={() => setEditTplAdminOnly(v => !v)}
                          style={{ width: "36px", height: "20px", borderRadius: "10px", background: editTplAdminOnly ? "#7c3aed" : "#374151", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
                        >
                          <div style={{ position: "absolute", top: "2px", left: editTplAdminOnly ? "18px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
                        </div>
                        <span style={{ fontSize: "12px", color: editTplAdminOnly ? "#a78bfa" : "#6b7280", display: "flex", alignItems: "center", gap: "4px" }}>
                          <Lock size={11} /> Solo visible para admin
                        </span>
                      </label>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button onClick={() => saveTemplate(tpl.id)} style={{ padding: "5px 12px", background: "#2563eb", border: "none", borderRadius: "6px", color: "white", fontSize: "12px", cursor: "pointer" }}>Guardar</button>
                        <button onClick={() => setEditTplId(null)} style={{ padding: "5px 10px", background: "#1a2540", border: "none", borderRadius: "6px", color: "#9ca3af", fontSize: "12px", cursor: "pointer" }}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: "white", fontSize: "13px", fontWeight: 500, margin: 0 }}>{tpl.title}</p>
                        {tpl.description && <p style={{ color: "#6b7280", fontSize: "12px", margin: "2px 0 0 0" }}>{tpl.description}</p>}
                        {tpl.dayOfMonth && (
                          <p style={{ color: "#f59e0b", fontSize: "11px", margin: "3px 0 0 0", fontWeight: 500 }}>
                            📅 Día {tpl.dayOfMonth} de cada mes
                          </p>
                        )}
                        {!!tpl.isAdminOnly && (
                          <p style={{ display: "inline-flex", alignItems: "center", gap: "3px", color: "#7c3aed", fontSize: "10px", fontWeight: 600, margin: "3px 0 0 0", background: "#2d1b69", borderRadius: "4px", padding: "1px 5px" }}>
                            <Lock size={9} /> Solo admin
                          </p>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button onClick={() => { setEditTplId(tpl.id); setEditTplTitle(tpl.title); setEditTplDesc(tpl.description || ""); setEditTplDay(tpl.dayOfMonth ? String(tpl.dayOfMonth) : ""); setEditTplAdminOnly(!!tpl.isAdminOnly); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", padding: "4px" }}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => removeTemplate(tpl.id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", padding: "4px" }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            {addingTpl ? (
              <div style={{ background: "#0d1424", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <input
                  autoFocus
                  placeholder="Nombre de la tarea fija"
                  value={newTplTitle}
                  onChange={e => setNewTplTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addTemplate(); if (e.key === "Escape") setAddingTpl(false); }}
                  style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "8px 12px", color: "white", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                />
                <input
                  placeholder="Descripción (opcional)"
                  value={newTplDesc}
                  onChange={e => setNewTplDesc(e.target.value)}
                  style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "8px 12px", color: "#9ca3af", fontSize: "13px", outline: "none", width: "100%", boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "#6b7280", fontSize: "12px", whiteSpace: "nowrap" }}>Día del mes:</span>
                  <input
                    type="number"
                    min={1} max={28}
                    placeholder="1-28"
                    value={newTplDay}
                    onChange={e => setNewTplDay(e.target.value)}
                    style={{ background: "#111827", border: "1px solid #253050", borderRadius: "8px", padding: "8px 10px", color: "#f59e0b", fontSize: "13px", outline: "none", width: "80px", boxSizing: "border-box" }}
                  />
                  <span style={{ color: "#4b5563", fontSize: "11px" }}>de cada mes (opcional)</span>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                  <div
                    onClick={() => setNewTplAdminOnly(v => !v)}
                    style={{ width: "36px", height: "20px", borderRadius: "10px", background: newTplAdminOnly ? "#7c3aed" : "#374151", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
                  >
                    <div style={{ position: "absolute", top: "2px", left: newTplAdminOnly ? "18px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "white", transition: "left 0.2s" }} />
                  </div>
                  <span style={{ fontSize: "12px", color: newTplAdminOnly ? "#a78bfa" : "#6b7280", display: "flex", alignItems: "center", gap: "4px" }}>
                    <Lock size={11} /> Solo visible para admin
                  </span>
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={addTemplate} style={{ flex: 1, padding: "7px", background: "#2563eb", border: "none", borderRadius: "8px", color: "white", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}>Crear</button>
                  <button onClick={() => { setAddingTpl(false); setNewTplTitle(""); setNewTplDesc(""); setNewTplDay(""); setNewTplAdminOnly(false); }} style={{ padding: "7px 12px", background: "#1a2540", border: "none", borderRadius: "8px", color: "#9ca3af", fontSize: "12px", cursor: "pointer" }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingTpl(true)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "10px", borderRadius: "10px", border: "1px dashed #253050", background: "none", color: "#6b7280", fontSize: "13px", cursor: "pointer" }}
              >
                <Plus size={14} />
                Nueva tarea fija mensual
              </button>
            )}
          </div>
        )}

      </div>
    </AppLayout>
  );
}

function TaskRow({ task, onToggle, onDelete }: { task: Task; onToggle: (t: Task) => void; onDelete: (id: number) => void }) {
  const done = task.status === "realizada";
  const isUnique = task.isRecurring === 0;

  function fmtDate(d: string | null) {
    if (!d) return "";
    const p = d.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px 12px",
      borderRadius: "10px", border: "1px solid",
      borderColor: done ? "#1a2540" : "#1f2937",
      background: done ? "#0d1424" : "#111827",
      opacity: done ? 0.7 : 1,
    }}>
      <button
        onClick={() => onToggle(task)}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 0", color: done ? "#22c55e" : isUnique ? "#a78bfa" : "#60a5fa", flexShrink: 0 }}
      >
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: done ? "#6b7280" : "white", fontSize: "13px", fontWeight: 500, margin: 0, textDecoration: done ? "line-through" : "none" }}>
          {task.title}
        </p>
        {task.description && (
          <p style={{ color: done ? "#4b5563" : "#6b7280", fontSize: "12px", margin: "2px 0 0 0" }}>{task.description}</p>
        )}
        {task.dueDate && (
          <p style={{ color: done ? "#4b5563" : "#f59e0b", fontSize: "11px", margin: "3px 0 0 0", fontWeight: 500 }}>
            📅 {fmtDate(task.dueDate)}
          </p>
        )}
        {!!task.isAdminOnly && (
          <p style={{ display: "inline-flex", alignItems: "center", gap: "3px", color: "#7c3aed", fontSize: "10px", fontWeight: 600, margin: "3px 0 0 0", background: "#2d1b69", borderRadius: "4px", padding: "1px 5px" }}>
            <Lock size={9} /> Solo admin
          </p>
        )}
      </div>
      <button
        onClick={() => onDelete(task.id)}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#374151", padding: "2px", flexShrink: 0 }}
        onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
        onMouseLeave={e => (e.currentTarget.style.color = "#374151")}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
