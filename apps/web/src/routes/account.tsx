import { createFileRoute } from "@tanstack/react-router";
import PageShell from "../components/PageShell";
import AccountPanel from "../components/settings/AccountPanel";

export const Route = createFileRoute("/account")({
  component: AccountPage,
});

function AccountPage() {
  return (
    <PageShell
      kicker="account"
      title="Your account."
      description="Your profile and password for this Kinglet instance."
    >
      <div className="mt-6">
        <AccountPanel />
      </div>
    </PageShell>
  );
}
