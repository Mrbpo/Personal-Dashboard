"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TaskStatusButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function restore() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/tasks/" + encodeURIComponent(taskId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", syncCanvas: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "恢复失败");
      router.refresh();
    } catch {
      setError("未能恢复，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={restore} disabled={busy}>
        <RotateCcw className={busy ? "animate-spin" : ""} />
        {busy ? "正在恢复…" : "撤销完成"}
      </Button>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
