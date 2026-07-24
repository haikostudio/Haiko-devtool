import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ActivityScreen } from "@/screens/activity-screen";

export default function ActivityRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ActivityScreen />
    </HostRouteBootstrapBoundary>
  );
}
