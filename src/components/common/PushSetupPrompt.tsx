import { useEffect, useState } from "react";
import { getScopedStorageKey } from "../../lib/storageNamespace";
import {
  FOCUS_TERMINAL_MESSAGE,
  focusTerminalFromNotification,
  readFocusTerminalFromUrl,
} from "../../lib/notificationNavigation";
import { isReplicaClient } from "../../lib/replication";
import {
  enablePushNotifications,
  hasRegisteredPushBefore,
  isPushBlockedBySettings,
  isPushSupported,
  isStandaloneWebApp,
  restorePushRegistration,
  shouldOfferPushSetup,
  type PushRegistration,
} from "../../lib/webPushSubscribe";

const DISMISSED_KEY = getScopedStorageKey("dispatcher.pushSetupDismissed");

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Worst case it is offered again next launch.
  }
}

/**
 * Offers push setup once, on a device where it can actually work.
 *
 * The permission prompt itself has to come from a tap — Safari will not show
 * it otherwise, and a refusal is permanent — so this exists to make that tap
 * findable rather than hidden behind a toolbar button, and to say what it is
 * for before iOS asks a question with no context.
 *
 * It also handles the invisible half: once permission is granted, re-offering
 * the existing subscription on every load needs no gesture and no UI, which is
 * what keeps the desktop's record fresh after iOS quietly retires one.
 */
export function PushSetupPrompt(props: { onRegister: (value: PushRegistration) => void }) {
  const [visible, setVisible] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Push is a phone concern: the desktop is the thing doing the sending, and
    // it already has the chime and the dock.
    if (!isReplicaClient()) {
      return;
    }

    const evaluate = () => {
      const permission =
        typeof Notification === "undefined" ? "unavailable" : Notification.permission;

      if (
        shouldOfferPushSetup({
          supported: isPushSupported(),
          standalone: isStandaloneWebApp(),
          permission,
          alreadyDismissed: wasDismissed(),
        })
      ) {
        setVisible(true);
        return;
      }

      if (
        isPushBlockedBySettings({
          supported: isPushSupported(),
          standalone: isStandaloneWebApp(),
          permission,
          hasRegisteredBefore: hasRegisteredPushBefore(),
        })
      ) {
        // Nothing to retry: the prompt is spent, so the only way back is
        // Settings. Saying so beats a feature that is quietly switched off.
        setBlocked(true);
        setVisible(true);
        return;
      }

      // Already granted: renew silently, so the tap is needed once ever.
      setBlocked(false);
      setVisible(false);
      void restorePushRegistration()
        .then((registration) => {
          if (registration) {
            props.onRegister(registration);
          }
        })
        .catch(() => {});
    };

    evaluate();

    // Re-check on the way back from somewhere else, because the somewhere else
    // is usually Settings. Permission can be granted or revoked while the app
    // is in the background and nothing tells the page about it.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        evaluate();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // Intentionally once per mount: this is a launch-time decision, and
    // re-running it on every render would re-subscribe in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tapping a notification, in both the shapes it can arrive as.
  useEffect(() => {
    if (!isReplicaClient() || !("serviceWorker" in navigator)) {
      return;
    }

    // Warm: the app was already running and the worker posted to it.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === FOCUS_TERMINAL_MESSAGE && event.data.terminalId) {
        focusTerminalFromNotification(event.data.terminalId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    // Cold: the worker had to launch the app, so the terminal came in the URL.
    // The workspace arrives from the desktop asynchronously, so this waits for
    // the tab to exist rather than giving up on the first miss.
    const { terminalId, cleanedHref } = readFocusTerminalFromUrl(window.location.href);
    let cancelled = false;
    if (terminalId) {
      window.history.replaceState(null, "", cleanedHref);
      const deadline = Date.now() + 15_000;
      const attempt = () => {
        if (cancelled || focusTerminalFromNotification(terminalId)) {
          return;
        }
        if (Date.now() < deadline) {
          window.setTimeout(attempt, 250);
        }
      };
      attempt();
    }

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  if (!visible) {
    return null;
  }

  const enable = () => {
    setBusy(true);
    setError(null);
    void enablePushNotifications()
      .then((result) => {
        if (result.ok) {
          props.onRegister(result.registration);
          setVisible(false);
          setBlocked(false);
          return;
        }
        // Still refused. Worth saying plainly: re-allowing in Settings does
        // not always restore the web app's own permission, and the difference
        // between "not fixed yet" and "fixed but stale" is invisible
        // otherwise.
        setError(
          result.reason.includes("denied")
            ? "iOS is still refusing. If Settings shows Dispatcher as allowed, remove the app from your Home Screen and add it again."
            : result.reason
        );
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const dismiss = () => {
    rememberDismissed();
    setVisible(false);
  };

  return (
    <div className="push-setup-backdrop" role="presentation">
      <div className="push-setup" role="dialog" aria-modal="true" aria-labelledby="push-setup-title">
        <h2 className="push-setup-title" id="push-setup-title">
          {blocked ? "Notifications are switched off" : "Get notified on this phone"}
        </h2>
        {blocked ? (
          <>
            <p className="push-setup-copy">
              iOS is refusing notifications for Dispatcher, so pushes are being delivered
              and then discarded. This usually happens after a few arrive without being
              shown.
            </p>
            <p className="push-setup-copy push-setup-note">
              Turn them back on in <strong>Settings → Notifications → Dispatcher</strong>.
              If it is not listed, remove this app from your Home Screen and add it again.
            </p>
          </>
        ) : (
          <>
            <p className="push-setup-copy">
              Dispatcher can notify you when a tab goes quiet, even with this app closed.
              Turn it on per tab with <strong>Push on Inactivity</strong> in the tab's
              right-click menu.
            </p>
            <p className="push-setup-copy push-setup-note">
              iOS will ask for permission next. It only asks once, so if you say no you
              would have to re-enable it in Settings.
            </p>
          </>
        )}
        {error && <p className="push-setup-error">{error}</p>}
        <div className="push-setup-actions">
          {blocked ? (
            <>
              <button type="button" className="push-setup-btn" onClick={dismiss} disabled={busy}>
                Dismiss
              </button>
              <button
                type="button"
                className="push-setup-btn is-primary"
                onClick={enable}
                disabled={busy}
              >
                {busy ? "Checking…" : "Try again"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="push-setup-btn" onClick={dismiss} disabled={busy}>
                Not now
              </button>
              <button
                type="button"
                className="push-setup-btn is-primary"
                onClick={enable}
                disabled={busy}
              >
                {busy ? "Enabling…" : "Enable"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
