import { createFileRoute, redirect } from "@tanstack/react-router";

/** Account settings live in the settings page's last tab; old links land there. */
export const Route = createFileRoute("/account")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", search: { tab: "account" } });
  },
});
