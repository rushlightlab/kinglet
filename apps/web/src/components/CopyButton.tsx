import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  return (
    <Button
      type="button"
      variant="chip"
      size="xs"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        toast.success("Copied to clipboard");
      }}
    >
      <CopyIcon data-icon="inline-start" />
      {label}
    </Button>
  );
}
