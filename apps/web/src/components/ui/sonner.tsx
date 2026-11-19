import { Toaster as Sonner, type ToasterProps } from "sonner";
import type { CSSProperties } from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const Toaster = ({ ...props }: ToasterProps) => {
  // SAFETY: Sonner reads these keys as CSS custom properties; React's
  // CSSProperties type does not model custom property names.
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "5px",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast font-mono text-xs",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
