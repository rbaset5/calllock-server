import httpx
import logging

logger = logging.getLogger(__name__)


class DashboardClient:
    """HTTP client for sending post-call data to the CallLock dashboard."""

    def __init__(self, webhook_url: str, webhook_secret: str, timeout: float = 15.0):
        self.jobs_url = webhook_url
        self.calls_url = webhook_url.replace("/api/webhook/jobs", "/api/webhook/calls")
        self.alerts_url = webhook_url.replace("/api/webhook/jobs", "/api/webhook/emergency-alerts")
        self.secret = webhook_secret
        self.timeout = timeout

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "X-Webhook-Secret": self.secret,
        }

    async def send_job(self, payload: dict) -> dict:
        """Send job/lead data to dashboard. Returns {"success": bool, ...}."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.jobs_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard job sync failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_call(self, payload: dict) -> dict:
        """Send call record to dashboard. Fire-and-forget with error logging."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.calls_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard call sync failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_emergency_alert(self, payload: dict) -> dict:
        """Send emergency alert to dashboard."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.alerts_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard emergency alert failed: {e}")
            return {"success": False, "error": str(e)}
