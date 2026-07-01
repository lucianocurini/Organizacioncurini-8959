import { useState } from "react";
import { Link } from "wouter";
import { Eye, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PolicyModal } from "@/components/policies/PolicyModal";

interface Props {
  policyId: number;
  onChanged?: () => void;
}

// Acciones de póliza (Ver / Editar / Eliminar) compartidas entre Pólizas y Reporte mensual.
// Mismos endpoints, mismos permisos y mismas confirmaciones que el módulo Pólizas.
export function PolicyActions({ policyId, onChanged }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [editData, setEditData] = useState<{ policy: any; company: any; insured: any } | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const openEdit = async () => {
    setLoadingEdit(true);
    try {
      const data = await api.get(`/api/policies/${policyId}`);
      setEditData(data);
      setShowModal(true);
    } catch {
      toast.error("No se pudo cargar la póliza.");
    } finally {
      setLoadingEdit(false);
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/api/policies/${policyId}`);
      toast.success("Póliza eliminada");
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo eliminar la póliza.");
    }
    setConfirmDelete(false);
  };

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        <Link href={`/polizas/${policyId}`}>
          <a className="p-1.5 text-gray-400 hover:text-white hover:bg-[#1f2937] rounded-md transition-all" title="Ver detalles">
            <Eye className="w-4 h-4" />
          </a>
        </Link>
        <button
          onClick={openEdit}
          disabled={loadingEdit}
          className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all disabled:opacity-50"
          title="Editar"
        >
          <Edit className="w-4 h-4" />
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all"
          title="Eliminar"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {showModal && editData && (
        <PolicyModal
          initial={editData}
          onClose={() => { setShowModal(false); setEditData(null); }}
          onSaved={() => { setShowModal(false); setEditData(null); onChanged?.(); }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2" style={{ fontFamily: "Syne, sans-serif" }}>¿Eliminar póliza?</h3>
            <p className="text-gray-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(false)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
              <button onClick={handleDelete} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-all">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
