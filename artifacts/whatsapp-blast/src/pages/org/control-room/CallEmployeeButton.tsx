// ── زر «اتصل» لصفحة الموظف ────────────────────────────────────────
// يفتح غرفة التحكّم على مكالمة هذا الموظف. لا يتصل بشيء بنفسه: الاتصال يبدأ هناك بضغطة.

import { useLocation } from "wouter";
import { PhoneCall } from "lucide-react";
import { ghost } from "../shared";

export function CallEmployeeButton({ employeeKey, className }: { employeeKey: string; className?: string }) {
  const [, go] = useLocation();
  return (
    <button className={className ?? ghost} onClick={() => go(`/org/control-room?call=${encodeURIComponent(employeeKey)}`)} title="مكالمة صوتية داخل التطبيق (نصف اتجاهية)">
      <PhoneCall className="w-3.5 h-3.5" /> اتصل
    </button>
  );
}
export default CallEmployeeButton;
