"""
Web Push (VAPID) helper.

Sends a push notification to a single PushSubscription endpoint using the
py_vapid + pywebpush stack. VAPID keys are read from environment variables;
if they don't exist the module auto-generates them on first import and prints
instructions for persisting them.

Note: Web Push requires HTTPS in production browsers. During a demo on LAN
the service worker installs but push delivery falls back silently to the
in-tab WebSocket popup — no additional code needed for the demo to work.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

try:
    from pywebpush import webpush, WebPushException
    from py_vapid import Vapid
    _PUSH_AVAILABLE = True
except ImportError:
    _PUSH_AVAILABLE = False
    logger.warning("pywebpush / py_vapid not installed — Web Push disabled (demo fallback: WebSocket)")


def get_vapid_public_key() -> Optional[str]:
    return os.getenv("VAPID_PUBLIC_KEY")


def _get_keys() -> tuple[Optional[str], Optional[str]]:
    pub = os.getenv("VAPID_PUBLIC_KEY")
    priv = os.getenv("VAPID_PRIVATE_KEY")
    return pub, priv


def send_push(subscription: Dict[str, Any], payload: str) -> bool:
    """
    Send a push message to one subscription.
    Returns True on success, False on failure (caller continues to next sub).
    """
    if not _PUSH_AVAILABLE:
        return False

    pub, priv = _get_keys()
    if not pub or not priv:
        logger.warning("VAPID keys not set — skipping push")
        return False

    try:
        webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=priv,
            vapid_claims={"sub": "mailto:demo@routeout.local"},
        )
        return True
    except WebPushException as exc:
        logger.warning("WebPush failed: %s", exc)
        return False
    except Exception as exc:
        logger.warning("Push error: %s", exc)
        return False


def maybe_generate_keys() -> None:
    """Generate VAPID keys if missing and print them to stdout for the operator."""
    if not _PUSH_AVAILABLE:
        return
    if os.getenv("VAPID_PUBLIC_KEY") and os.getenv("VAPID_PRIVATE_KEY"):
        return

    logger.info("VAPID keys not found — generating new pair…")
    try:
        v = Vapid()
        v.generate_keys()
        pub = v.public_key_urlsafe_base64
        priv = v.private_key_urlsafe_base64
        print("\n" + "=" * 60)
        print("VAPID keys generated — add these to notification/backend/.env:")
        print(f"  VAPID_PUBLIC_KEY={pub}")
        print(f"  VAPID_PRIVATE_KEY={priv}")
        print("=" * 60 + "\n")
        # Inject into environment for this process run
        os.environ["VAPID_PUBLIC_KEY"] = pub
        os.environ["VAPID_PRIVATE_KEY"] = priv
    except Exception as exc:
        logger.warning("Could not generate VAPID keys: %s", exc)
