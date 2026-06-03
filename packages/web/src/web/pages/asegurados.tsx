import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Plus, Edit, Trash2, User, X, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

export default function Asegurados() {
  const [insureds, setInsureds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form, setForm] = useState({ name: "", dni: "", phone: "", email: "", address: "" });

  const load = () => {
    setLoading(true);
    api.get(`/api/insureds${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setInsureds).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [q]);

  function openCreate() { setEditItem(null); setForm({ name: "", dni: "", phone: "", email: "", address: "" }); setShowModal(true); }
  function openEdit(i: any) { setEditItem(i); setForm({ name: i.name, dni: i.dni || "", phone: i.phone || "", email: i.email || "", address: i.address || "" }); setShowModal(true); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    try {
      if (editItem) {
        await api.put(`/api/insureds/${editItem.id}`, form);
        toast.success("Asegurado actualizado");
      } else {
        await api.post("/api/insureds", form);
        toast.success("Asegurado creado");
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.delete(`/api/insureds/${id}`);
      toast.success("Asegurado eliminado");
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
    setDeleteId(null);
  }

  const inputClass = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";

  return (
    <AppLayout>
      <div className="p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Asegurados</h1>
            <p className="text-gray-400 text-sm mt-1">{insureds.length} registros</p>
          </div>
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all">
            <Plus className="w-4 h-4" /> Nuevo Asegurado
          </button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm mb-5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Buscar por nombre o DNI..."
            className="w-full pl-9 pr-4 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="border-b border-[#1f2937]">
                <tr>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Nombre</th>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">DNI / CUIT</th>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Teléfono</th>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Email</th>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">Dirección</th>
                  <th className="text-right text-xs text-gray-400 font-medium py-3 px-4">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {insureds.length === 0 ? (
                  <tr><td colSpan={6} className="py-12 text-center text-gray-500 text-sm">No se encontraron asegurados</td></tr>
                ) : insureds.map(i => (
                  <tr key={i.id} className="border-b border-[#1f2937] table-row-hover transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center text-xs font-bold text-blue-400 flex-shrink-0">
                          {i.name.charAt(0)}
                        </div>
                        <span className="text-sm text-white font-medium">{i.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4"><span className="text-sm text-gray-300 font-mono">{i.dni || "—"}</span></td>
                    <td className="py-3 px-4"><span className="text-sm text-gray-300">{i.phone || "—"}</span></td>
                    <td className="py-3 px-4"><span className="text-sm text-gray-300">{i.email || "—"}</span></td>
                    <td className="py-3 px-4"><span className="text-sm text-gray-400 truncate max-w-[200px] block">{i.address || "—"}</span></td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(i)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all"><Edit className="w-4 h-4" /></button>
                        <button onClick={() => setDeleteId(i.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                {editItem ? "Editar Asegurado" : "Nuevo Asegurado"}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div><label className="block text-xs text-gray-400 mb-1.5">Nombre completo *</label><input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Juan Pérez" /></div>
              <div><label className="block text-xs text-gray-400 mb-1.5">DNI / CUIT</label><input className={inputClass} value={form.dni} onChange={e => setForm(f => ({ ...f, dni: e.target.value }))} placeholder="25.456.789" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs text-gray-400 mb-1.5">Teléfono</label><input className={inputClass} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="011-4523-6789" /></div>
                <div><label className="block text-xs text-gray-400 mb-1.5">Email</label><input className={inputClass} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="juan@mail.com" /></div>
              </div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Dirección</label><input className={inputClass} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="Av. Corrientes 1234, CABA" /></div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
                <button type="submit" disabled={formLoading} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {formLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editItem ? "Guardar" : "Crear"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2">¿Eliminar asegurado?</h3>
            <p className="text-gray-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg">Cancelar</button>
              <button onClick={() => handleDelete(deleteId)} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
