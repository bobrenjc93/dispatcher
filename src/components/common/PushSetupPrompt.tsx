import { useEffect, useState } from "react";
import { getScopedStorageKey } from "../../lib/storageNamespace";
import { isReplicaClient } from "../../lib/replication";
import {
  enablePushNotifications,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Push is a phone concern: the desktop is the thing doing the sending, and
    // it already has the chime and the dock.
    if (!isReplicaClient()) {
      return;
    }

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

    // Already granted: renew silently, so the tap is needed once ever.
    void restorePushRegistration()
      .then((registration) => {
        if (registration) {
          props.onRegister(registration);
        }
      })
      .catch(() => {});
    // Intentionally once per mount: this is a launch-time decision, and
    // re-running it on every render would re-subscribe in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          return;
        }
        setError(result.reason);
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
          Get notified on this phone
        </h2>
        <p className="push-setup-copy">
          Dispatcher can notify you when a tab needs attention, even with the app closed
          and your laptop shut. It uses the settings you already have per tab — Notify on
          Inactivity and Bounce on Inactivity.
        </p>
        <p className="push-setup-copy push-setup-note">
          iOS will ask for permission next. It only asks once, so if you say no you would
          have to re-enable it in Settings.
        </p>
        {error && <p className="push-setup-error">{error}</p>}
        <div className="push-setup-actions">
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
        </div>
      </div>
    </div>
  );
}
