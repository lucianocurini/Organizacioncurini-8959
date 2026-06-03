import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth";
import { Plus, Trash2, X, Loader2, Shield, User, Edit2, Ban, CheckCircle, Download, DatabaseBackup } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

interface UserRow { id: number; name: string; email: string; role: string; active: number; createdAt: string; }

const inputClass = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";

export default function Usuarios() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });
  const [editForm, setEditForm] = useState({ name: "", email: "", password: "", role: "user" });

  useEffect(() => {
    if (user?.role !== "admin") { navigate("/"); return; }
    load();
  }, [user]);

  const load = () => {
    setLoading(true);
    api.get("/api/users").then(setUsers).finally(() => setLoading(false));
  };

  function openEdit(u: UserRow) {
    setEditTarget(u);
    setEditForm({ name: u.name, email: u.email, password: "", role: u.role });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    try {
      await api.post("/api/users", form);
      toast.success("Usuario creado");
      setShowModal(false);
      setForm({ name: "", email: "", password: "", role: "user" });
      load();
    } catch (err: any) { toast.error(err.message); }
    finally { setFormLoading(false); }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setFormLoading(true);
    try {
      const body: any = { name: editForm.name, email: editForm.email, role: editForm.role };
      if (editForm.password) body.password = editForm.password;
      await api.put(`/api/users/${editTarget.id}`, body);
      toast.success("Usuario actualizado");
      setEditTarget(null);
      load();
    } catch (err: any) { toast.error(err.message); }
    finally { setFormLoading(false); }
  }

  async function toggleActive(u: UserRow) {
    const newActive = u.active === 1 ? 0 : 1;
    try {
      await api.put(`/api/users/${u.id}`, { active: newActive });
      toast.success(newActive === 1 ? "Usuario activado" : "Usuario suspendido");
      load();
    } catch (err: any) { toast.error(err.message); }
  }

  async function handleBackup() {
    setBackingUp(true);
    try {
      const sessionId = localStorage.getItem("session_id") || "";
      const res = await fetch("/api/backup", {
        headers: { "x-session-id": sessionId },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Error ${res.status}`);
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().substring(0, 10);
      a.href = url;
      a.download = `curini-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Backup descargado correctamente");
    } catch (e: any) {
      toast.error(e.message || "Error al generar backup");
    } finally {
      setBackingUp(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.delete(`/api/users/${id}`);
      toast.success("Usuario eliminado");
      load();
    } catch (err: any) { toast.error(err.message); }
    setDeleteId(null);
  }

  const isSelf = (u: UserRow) => u.id === (user as any)?.id;

  return (
    <AppLayout>
      <div className="p-8 max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Usuarios</h1>
            <p className="text-gray-400 text-sm mt-1">Gestión de acceso al sistema</p>
          </div>
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all">
            <Plus className="w-4 h-4" /> Nuevo usuario
          </button>
        </div>

        <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="border-b border-[#1f2937]">
              <tr>
                <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Usuario</th>
                <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Email</th>
                <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Rol</th>
                <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Estado</th>
                <th className="text-right text-xs text-gray-400 font-medium py-3 px-4">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="py-12 text-center text-gray-500 text-sm">Cargando...</td></tr>
              ) : users.map(u => (
                <tr key={u.id} className={cn("border-b border-[#1f2937] transition-colors", u.active === 0 ? "opacity-60" : "hover:bg-[#1a2540]/30")}>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center text-xs font-bold text-blue-400 flex-shrink-0">
                        {u.name.charAt(0)}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white">{u.name}</span>
                        {isSelf(u) && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] border border-blue-500/30 bg-blue-500/10 text-blue-400">vos</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4"><span className="text-sm text-gray-300">{u.email}</span></td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${
                      u.role === "admin"
                        ? "bg-purple-500/15 text-purple-400 border-purple-500/20"
                        : "bg-gray-500/15 text-gray-400 border-gray-500/20"
                    }`}>
                      {u.role === "admin" ? <Shield className="w-3 h-3" /> : <User className="w-3 h-3" />}
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {u.active === 1 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border bg-green-500/15 text-green-400 border-green-500/20">
                        <CheckCircle className="w-3 h-3" /> Activo
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border bg-red-500/15 text-red-400 border-red-500/20">
                        <Ban className="w-3 h-3" /> Suspendido
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-1">
                      {/* Editar */}
                      <button onClick={() => openEdit(u)}
                        className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all" title="Editar">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      {/* Suspender / Activar — no aplica a uno mismo */}
                      {!isSelf(u) && (
                        u.active === 1 ? (
                          <button onClick={() => toggleActive(u)}
                            className="p-1.5 text-gray-400 hover:text-yellow-400 hover:bg-[#1f2937] rounded-md transition-all" title="Suspender acceso">
                            <Ban className="w-4 h-4" />
                          </button>
                        ) : (
                          <button onClick={() => toggleActive(u)}
                            className="p-1.5 text-gray-400 hover:text-green-400 hover:bg-[#1f2937] rounded-md transition-all" title="Reactivar acceso">
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        )
                      )}
                      {/* Eliminar — no aplica a uno mismo */}
                      {!isSelf(u) ? (
                        <button onClick={() => setDeleteId(u.id)}
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all" title="Eliminar">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      ) : (
                        <span className="p-1.5 text-gray-700 cursor-not-allowed" title="No podés eliminar tu propio usuario">
                          <Trash2 className="w-4 h-4" />
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Backup section */}
        <div className="mt-8 bg-[#111827] border border-[#1f2937] rounded-xl p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                <DatabaseBackup className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-white font-semibold text-sm" style={{ fontFamily: "Syne, sans-serif" }}>Backup de datos</h2>
                <p className="text-gray-400 text-xs mt-1 leading-relaxed">
                  Descargá un archivo JSON con toda la información del sistema: pólizas, asegurados, pagos, tareas, siniestros y más.<br />
                  Guardalo en un lugar seguro antes de hacer cambios importantes.
                </p>
              </div>
            </div>
            <button
              onClick={handleBackup}
              disabled={backingUp}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm rounded-lg font-medium transition-all flex-shrink-0"
            >
              {backingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {backingUp ? "Generando..." : "Descargar backup"}
            </button>
          </div>
        </div>

      </div>

      {/* Modal crear */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Nuevo usuario</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div><label className="block text-xs text-gray-400 mb-1.5">Nombre *</label>
                <input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Juan García" />
              </div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Email *</label>
                <input className={inputClass} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required placeholder="juan@curini.com" />
              </div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Contraseña *</label>
                <input className={inputClass} type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required placeholder="••••••••" minLength={6} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Rol</label>
                <select className={inputClass} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="user">Usuario</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
                <button type="submit" disabled={formLoading} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {formLoading && <Loader2 className="w-4 h-4 animate-spin" />} Crear usuario
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal editar */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Editar usuario</h2>
              <button onClick={() => setEditTarget(null)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleEdit} className="p-6 space-y-4">
              <div><label className="block text-xs text-gray-400 mb-1.5">Nombre *</label>
                <input className={inputClass} value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Email *</label>
                <input className={inputClass} type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} required />
              </div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Nueva contraseña <span className="text-gray-600">(dejar vacío para no cambiar)</span></label>
                <input className={inputClass} type="password" value={editForm.password} onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••••" minLength={6} />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Rol</label>
                <select className={inputClass} value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="user">Usuario</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setEditTarget(null)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
                <button type="submit" disabled={formLoading} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {formLoading && <Loader2 className="w-4 h-4 animate-spin" />} Guardar cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmar eliminar */}
      {deleteId !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2">¿Eliminar usuario?</h3>
            <p className="text-gray-400 text-sm mb-5">El usuario perderá acceso al sistema.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg">Cancelar</button>
              <button onClick={() => handleDelete(deleteId!)} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
