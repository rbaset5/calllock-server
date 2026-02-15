import httpx
import logging

logger = logging.getLogger(__name__)


class V2Client:
    """HTTP client for the V2 backend tool endpoints."""

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def lookup_caller(self, phone: str, call_id: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/lookup_caller",
                    json={
                        "call": {
                            "call_id": call_id,
                            "from_number": phone,
                            "metadata": {},
                        },
                        "args": {},
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"lookup_caller failed: {e}")
            return {"found": False, "message": "Lookup failed — proceeding without history."}

    async def book_service(
        self,
        customer_name: str,
        problem: str,
        address: str,
        preferred_time: str,
        phone: str,
    ) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/api/retell/book-service",
                    json={
                        "customer_name": customer_name,
                        "customer_phone": phone,
                        "issue_description": problem,
                        "service_address": address,
                        "preferred_time": preferred_time,
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"book_service failed: {e}")
            return {"booked": False, "error": str(e)}

    async def create_callback(
        self,
        phone: str,
        callback_type: str = "service",
        reason: str = "",
    ) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/create_callback",
                    json={
                        "call": {"from_number": phone, "metadata": {}},
                        "args": {
                            "callback_type": callback_type,
                            "execution_message": reason,
                        },
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"create_callback failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_sales_lead_alert(self, phone: str, reason: str = "") -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/send_sales_lead_alert",
                    json={
                        "call": {"from_number": phone, "metadata": {}},
                        "args": {"execution_message": reason},
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"send_sales_lead_alert failed: {e}")
            return {"success": False, "error": str(e)}
