import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { passwordChecks } from "@/lib/password";

export default function PasswordRequirements({ value }: { value: string }) {
  return (
    <ul className="mt-2 flex flex-col gap-1 font-mono text-[10px]">
      {passwordChecks(value).map((check) => (
        <li
          key={check.id}
          className={cn("flex items-center gap-1.5", check.ok ? "text-gold" : "text-mist-faint")}
        >
          {check.ok ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
          {check.label}
        </li>
      ))}
    </ul>
  );
}
