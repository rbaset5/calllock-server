"""Startup configuration validation.

Checks that all required environment variables are set before the server
accepts connections.  Called from bot.py at import time so that a missing
key causes a clear startup failure rather than a silent mid-call crash.
"""

import os
import sys
import logging

logger = logging.getLogger(__name__)

REQUIRED_VARS = [
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "INWORLD_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "V2_BACKEND_URL",
]

OPTIONAL_VARS = [
    "DASHBOARD_JOBS_URL",
    "DASHBOARD_CALLS_URL",
    "DASHBOARD_ALERTS_URL",
    "DASHBOARD_WEBHOOK_SECRET",
    "DASHBOARD_USER_EMAIL",
    "INWORLD_VOICE_ID",
    "DEEPGRAM_TTS_VOICE",
    "LOG_LEVEL",
]


def validate_config() -> None:
    """Validate environment variables at startup.

    Exits the process with a clear error if any required variable is missing
    or empty.  Logs warnings for missing optional variables.
    """
    missing = [var for var in REQUIRED_VARS if not os.getenv(var)]

    if missing:
        print(
            f"\nFATAL: Missing required environment variables:\n"
            f"  {', '.join(missing)}\n"
            f"\nSet them in .env (local) or fly secrets (production).\n",
            file=sys.stderr,
        )
        sys.exit(1)

    for var in OPTIONAL_VARS:
        if not os.getenv(var):
            logger.warning("Optional env var %s is not set", var)
