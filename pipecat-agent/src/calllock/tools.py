import httpx
import logging

from calllock.circuit_breaker import CircuitBreaker

logger = logging.getLogger(__name__)


class V2Client:
    """HTTP client for the V2 backend tool endpoints.

    Wraps each call with a circuit breaker: after 3 consecutive failures,
    V2 calls are skipped for 60s and graceful fallback responses are returned
    so the state machine can route to callback instead of hanging.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._circuit = CircuitBreaker(
            failure_threshold=3,
            cooldown_seconds=60.0,
            label="V2 backend",
        )
        if client is not None:
            self._client = client
        else:
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["X-API-Key"] = api_key
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=self.timeout,
            )

    async def close(self):
        """Close the shared HTTP client. Call at end of call."""
        await self._client.aclose()

    async def lookup_caller(self, phone: str, call_id: str) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning unknown caller")
            return {"found": False, "message": "V2 backend unavailable — proceeding without history."}
        try:
            resp = await self._client.post(
                "/webhook/retell/lookup_caller",
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
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("lookup_caller failed: %s", e)
            return {"found": False, "message": "Lookup failed — proceeding without history."}

    async def book_service(
        self,
        customer_name: str,
        problem: str,
        address: str,
        preferred_time: str,
        phone: str,
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning booking failure")
            return {"booked": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/book_appointment",
                json={
                    "call": {
                        "call_id": "pipecat_call",
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": {
                        "customer_name": customer_name,
                        "customer_phone": phone,
                        "issue_description": problem,
                        "service_address": address,
                        "preferred_time": preferred_time,
                    },
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("book_service failed: %s", e)
            return {"booked": False, "error": str(e)}

    async def create_callback(
        self,
        phone: str,
        call_id: str = "pipecat_call",
        callback_type: str = "service",
        reason: str = "",
        customer_name: str = "",
        urgency: str = "normal",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning callback failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/create_callback",
                json={
                    "call": {
                        "call_id": call_id,
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": {
                        "reason": reason or "Callback requested",
                        "callback_type": callback_type,
                        "customer_name": customer_name,
                        "urgency": urgency,
                    },
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("create_callback failed: %s", e)
            return {"success": False, "error": str(e)}

    async def send_sales_lead_alert(self, phone: str, reason: str = "") -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning alert failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            resp = await self._client.post(
                "/webhook/retell/send_sales_lead_alert",
                json={
                    "call": {"from_number": phone, "metadata": {}},
                    "args": {"execution_message": reason},
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("send_sales_lead_alert failed: %s", e)
            return {"success": False, "error": str(e)}

    async def manage_appointment(
        self,
        action: str,
        phone: str,
        call_id: str = "pipecat_call",
        booking_uid: str = "",
        reason: str = "",
        new_time: str = "",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning appointment failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            args = {"action": action}
            if booking_uid:
                args["booking_uid"] = booking_uid
            if reason:
                args["reason"] = reason
            if new_time:
                args["new_date_time"] = new_time

            resp = await self._client.post(
                "/webhook/retell/manage_appointment",
                json={
                    "call": {
                        "call_id": call_id,
                        "from_number": phone,
                        "metadata": {},
                    },
                    "args": args,
                },
            )
            resp.raise_for_status()
            self._circuit.record_success()
            return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("manage_appointment failed: %s", e)
            return {"success": False, "error": str(e)}
