import { useEffect, useState } from "react";
import { isWeb } from "@/constants/platform";

// The build bakes its own commit SHA into the bundle. When the live server
// serves a `/version.json` whose `.sha` differs from the baked one, a newer
// build has been deployed and the running app is stale.
const buildSha = process.env.EXPO_PUBLIC_BUILD_SHA;

const POLL_INTERVAL_MS = 60_000;
const INITIAL_CHECK_DELAY_MS = 3_000;

/**
 * Web-only: returns true once a newer deployed build is detected.
 *
 * On native this is always false and runs no effects/timers — mobile app
 * updates come from the app stores, not this in-app banner. The feature is
 * also inert in local dev where `EXPO_PUBLIC_BUILD_SHA` is undefined.
 */
export function useAppUpdateAvailable(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // Gate everything on web + a baked sha. Native never touches DOM APIs and
    // never polls; without a baked sha there's nothing to compare against.
    if (!isWeb || !buildSha) return;

    let cancelled = false;
    // Guard against overlapping fetches (poll + focus + visibility can stack).
    let inFlight = false;

    async function check(): Promise<void> {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/version.json", { cache: "no-store" });
        if (!response.ok) return;
        const data: unknown = await response.json();
        const liveSha =
          typeof data === "object" && data !== null && "sha" in data
            ? (data as { sha?: unknown }).sha
            : undefined;
        if (cancelled) return;
        if (typeof liveSha === "string" && liveSha.length > 0 && liveSha !== buildSha) {
          // Once we've seen a new version, stay true — don't flap back.
          setUpdateAvailable(true);
        }
      } catch {
        // Network/parse errors are non-fatal: leave state as-is and retry later.
      } finally {
        inFlight = false;
      }
    }

    function runCheck(): void {
      void check();
    }

    // Initial check shortly after mount so it doesn't race startup.
    const initialTimer = setTimeout(runCheck, INITIAL_CHECK_DELAY_MS);
    const pollTimer = setInterval(runCheck, POLL_INTERVAL_MS);

    function handleVisibilityChange(): void {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        runCheck();
      }
    }

    // Also check when the user returns to the app.
    window.addEventListener("focus", runCheck);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(pollTimer);
      window.removeEventListener("focus", runCheck);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, []);

  return updateAvailable;
}
