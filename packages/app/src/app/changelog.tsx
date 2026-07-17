import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ChangelogScreen } from "@/screens/changelog-screen";

export default function ChangelogRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ChangelogScreen />
    </HostRouteBootstrapBoundary>
  );
}
