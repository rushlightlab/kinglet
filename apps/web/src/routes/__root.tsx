import { useState } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { getToken, setToken } from "../api";
import TokenGate from "../components/TokenGate";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const [token, setTokenState] = useState<string | null>(() => getToken());

  if (!token) {
    return (
      <TokenGate
        onSave={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  return <Outlet />;
}
