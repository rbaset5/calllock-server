import asyncio
import httpx
import logging

logger = logging.getLogger(__name__)


class DashboardClient:
    """HTTP client for sending post-call data to the CallLock dashboard.

    Uses separate URL env vars per endpoint (no string replacement) and
    retries once with a 2-second backoff on failure.
    """

    def __init__(
        self,
        *,
        jobs_url: str,
        calls_url: str,
        alerts_url: str,
        webhook_secret: str,
        timeout: float = 15.0,
    ):
        self.jobs_url = jobs_url
        self.calls_url = calls_url
        self.alerts_url = alerts_url
        self.secret = webhook_secret
        self.timeout = timeout

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "X-Webhook-Secret": self.secret,
        }

    async def _post_with_retry(self, url: str, payload: dict, label: str) -> dict:
        """POST with one retry after 2s on failure."""
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.post(url, json=payload, headers=self._headers())
                    resp.raise_for_status()
                    return resp.json()
            except Exception as e:
                if attempt == 0:
                    logger.warning("%s failed (attempt 1), retrying in 2s: %s", label, e)
                    await asyncio.sleep(2)
                else:
                    logger.error("%s failed after retry: %s", label, e)
                    return {"success": False, "error": str(e)}
        return {"success": False, "error": "unreachable"}

    async def send_job(self, payload: dict) -> dict:
        """Send job/lead data to dashboard."""
        return await self._post_with_retry(self.jobs_url, payload, "Dashboard job sync")

    async def send_call(self, payload: dict) -> dict:
        """Send call record to dashboard."""
        return await self._post_with_retry(self.calls_url, payload, "Dashboard call sync")

    async def send_emergency_alert(self, payload: dict) -> dict:
        """Send emergency alert to dashboard."""
        return await self._post_with_retry(self.alerts_url, payload, "Dashboard emergency alert")
